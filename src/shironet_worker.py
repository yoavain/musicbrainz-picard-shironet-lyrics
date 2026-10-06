"""Fetch queued songs from Shironet slowly, and learn a pace it tolerates.

No Picard or Qt imports: scripts/shironet_worker.py runs this outside Picard.

Pacing (stored in the cache's meta table, so it carries over between runs):
- Requests are spaced by `interval` seconds, with +/-20% jitter.
- After SPEEDUP_AFTER successful requests in a row, `interval` shrinks by 10%.
- A CAPTCHA redirect stops requests for `cooldown` seconds. The cooldown doubles
  on each challenge until a request succeeds again, and `interval` grows by 50%.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass, field
import difflib
import http.cookiejar
import json
import random
import statistics
import time
import urllib.error
import urllib.request

from .lyrics_cache import SOURCE_SHIRONET, LyricsCache
from .shironet import is_challenge, parse_lyrics_page, parse_search, pick_result, search_url
from .shironet_queue import (
    DONE,
    FAILED,
    NOT_FOUND,
    PURPOSE_CALIBRATE,
    QueueItem,
    log_request,
    next_pending,
    update,
)


USER_AGENT = 'shironet-lyrics/0.1 (MusicBrainz Picard plugin; personal lyrics cache)'
REQUEST_TIMEOUT = 30.0
# Network errors on one song before it is marked failed. CAPTCHAs do not count.
MAX_ATTEMPTS = 5
PACE_META_KEY = 'shironet_pace'

OK = 'ok'
CHALLENGE = 'challenge'
ERROR = 'error'


# --- pacing -----------------------------------------------------------------

@dataclass
class PaceState:
    interval: float = 120.0
    cooldown: float = 1800.0
    streak: int = 0
    challenged: bool = False  # True from a challenge until the next success


@dataclass
class PaceLimits:
    min_interval: float = 20.0
    max_interval: float = 1800.0
    base_cooldown: float = 1800.0
    max_cooldown: float = 8 * 3600.0
    speedup_after: int = 10


class Pacer:
    def __init__(self, state: PaceState, limits: PaceLimits, rng: random.Random | None = None):
        self.state = state
        self.limits = limits
        self._rng = rng or random.Random()

    def next_wait(self) -> float:
        return self.state.interval * self._rng.uniform(0.8, 1.2)

    def on_success(self) -> None:
        state = self.state
        if state.challenged:
            state.challenged = False
            state.cooldown = self.limits.base_cooldown
        state.streak += 1
        if state.streak >= self.limits.speedup_after:
            state.interval = max(self.limits.min_interval, state.interval * 0.9)
            state.streak = 0

    def on_challenge(self) -> float:
        """Seconds to wait before the next request."""
        state = self.state
        wait = state.cooldown
        state.cooldown = min(self.limits.max_cooldown, state.cooldown * 2)
        state.interval = min(self.limits.max_interval, state.interval * 1.5)
        state.streak = 0
        state.challenged = True
        return wait

    def on_error(self) -> float:
        return self.state.interval * 2


def load_pace(cache: LyricsCache, default: PaceState) -> PaceState:
    raw = cache.get_meta(PACE_META_KEY)
    if not raw:
        return default
    try:
        return PaceState(**json.loads(raw))
    except (TypeError, ValueError):
        return default


def save_pace(cache: LyricsCache, state: PaceState) -> None:
    cache.set_meta(PACE_META_KEY, json.dumps(asdict(state)))


# --- HTTP -------------------------------------------------------------------

@dataclass(frozen=True)
class Response:
    outcome: str  # OK | CHALLENGE | ERROR
    http_status: int | None
    text: str = ''
    detail: str = ''


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # a redirect is reported, not followed: it is how a CAPTCHA shows


class ShironetClient:
    """GETs Shironet pages with a persistent cookie jar, like one browser session."""

    def __init__(self, cookie_path: str | None = None, user_agent: str = USER_AGENT):
        self._jar = http.cookiejar.LWPCookieJar(cookie_path) if cookie_path else None
        if self._jar is not None:
            try:
                self._jar.load(ignore_discard=True)
            except (OSError, http.cookiejar.LoadError):
                pass
        handlers = [_NoRedirect()]
        if self._jar is not None:
            handlers.append(urllib.request.HTTPCookieProcessor(self._jar))
        self._opener = urllib.request.build_opener(*handlers)
        self._headers = {'User-Agent': user_agent, 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.5'}

    def get(self, url: str) -> Response:
        request = urllib.request.Request(url, headers=self._headers)
        try:
            with self._opener.open(request, timeout=REQUEST_TIMEOUT) as reply:
                text = reply.read().decode('utf-8', errors='replace')
                status = reply.status
        except urllib.error.HTTPError as exc:
            location = exc.headers.get('Location', '') if exc.headers else ''
            if is_challenge(location):
                return self._done(Response(CHALLENGE, exc.code, detail=location[:200]))
            return self._done(Response(ERROR, exc.code, detail=f'{exc.code} {location[:150]}'.strip()))
        except (urllib.error.URLError, OSError) as exc:
            return self._done(Response(ERROR, None, detail=str(exc)[:200]))
        if is_challenge(url, text):
            return self._done(Response(CHALLENGE, status, detail='challenge page'))
        return self._done(Response(OK, status, text))

    def _done(self, response: Response) -> Response:
        if self._jar is not None:
            try:
                self._jar.save(ignore_discard=True)
            except OSError:
                pass
        return response


# --- one song ---------------------------------------------------------------

def _request(cache, client, pacer, kind, url, clock) -> Response:
    response = client.get(url)
    log_request(cache, kind, response.outcome, response.http_status, response.detail or None, at=clock())
    if response.outcome == OK:
        pacer.on_success()
    return response


def _failed_attempt(cache: LyricsCache, item: QueueItem, response: Response) -> str:
    if response.outcome == CHALLENGE:
        return CHALLENGE  # not the song's fault: no attempt counted
    status = FAILED if item.attempts + 1 >= MAX_ATTEMPTS else None
    update(cache, item, status=status, result=response.detail or 'error', add_attempt=True)
    return ERROR


def process_item(
    cache: LyricsCache,
    client,
    pacer: Pacer,
    item: QueueItem,
    before_request: Callable[[], None],
    clock: Callable[[], float] = time.time,
) -> str:
    """Fetch one song. Returns DONE, NOT_FOUND, CHALLENGE or ERROR."""
    url = item.lyrics_url
    if not url:
        before_request()
        response = _request(cache, client, pacer, 'search', search_url(item.title), clock)
        if response.outcome != OK:
            return _failed_attempt(cache, item, response)
        found = parse_search(response.text)
        match = pick_result(found, item.artist, item.title)
        if match is None:
            update(cache, item, status=NOT_FOUND, result=f'no match in {len(found)} results', add_attempt=True)
            return NOT_FOUND
        url = match.url
        update(cache, item, lyrics_url=url)

    before_request()
    response = _request(cache, client, pacer, 'lyrics', url, clock)
    if response.outcome != OK:
        return _failed_attempt(cache, item, response)
    page = parse_lyrics_page(response.text)
    if page is None:
        update(cache, item, status=NOT_FOUND, result='no lyrics on the page', add_attempt=True)
        return NOT_FOUND

    if item.purpose == PURPOSE_CALIBRATE:
        cached = cache.get(item.artist, item.title)
        ratio = similarity(cached.lyrics, page.lyrics) if cached else 0.0
        update(cache, item, status=DONE, result=f'similarity {ratio:.2f}', add_attempt=True)
    else:
        stored = cache.put(item.artist, item.title, page.lyrics, SOURCE_SHIRONET, url)
        update(cache, item, status=DONE, result=stored.value, add_attempt=True)
    return DONE


def similarity(a: str, b: str) -> float:
    """0..1 similarity of two lyrics, ignoring whitespace differences."""
    return difflib.SequenceMatcher(None, ' '.join(a.split()), ' '.join(b.split()), autojunk=False).ratio()


# --- the run loop -------------------------------------------------------------

@dataclass
class RunStats:
    requests: int = 0
    done: int = 0
    not_found: int = 0
    challenges: int = 0
    errors: int = 0
    stopped_because: str = ''
    started: float = field(default_factory=time.time)


def run(
    cache: LyricsCache,
    client,
    pacer: Pacer,
    *,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.time,
    max_requests: int | None = None,
    max_seconds: float | None = None,
    stop_on_challenge: bool = False,
    should_stop: Callable[[], bool] = lambda: False,
    say: Callable[[str], None] = lambda message: None,
    on_challenge: Callable[[float], None] = lambda wait: None,
) -> RunStats:
    """Process pending songs until the queue is empty or a limit is reached."""
    stats = RunStats(started=clock())
    first_request = True

    def before_request() -> None:
        nonlocal first_request
        if not first_request:
            sleep(pacer.next_wait())
        first_request = False
        stats.requests += 1

    while True:
        if should_stop():
            stats.stopped_because = 'stopped'
            break
        if max_requests is not None and stats.requests >= max_requests:
            stats.stopped_because = 'request limit'
            break
        if max_seconds is not None and clock() - stats.started >= max_seconds:
            stats.stopped_because = 'time limit'
            break
        item = next_pending(cache)
        if item is None:
            stats.stopped_because = 'queue empty'
            break

        outcome = process_item(cache, client, pacer, item, before_request, clock)
        save_pace(cache, pacer.state)
        if outcome == DONE:
            stats.done += 1
            say(f'done: {item.artist} - {item.title}')
        elif outcome == NOT_FOUND:
            stats.not_found += 1
            say(f'not found: {item.artist} - {item.title}')
        elif outcome == ERROR:
            stats.errors += 1
            wait = pacer.on_error()
            say(f'error on {item.artist} - {item.title}; waiting {wait:.0f} s')
            sleep(wait)
            first_request = True
        else:
            stats.challenges += 1
            wait = pacer.on_challenge()
            save_pace(cache, pacer.state)
            on_challenge(wait)
            if stop_on_challenge:
                stats.stopped_because = 'challenge'
                break
            say(f'CAPTCHA after {stats.requests} requests; cooling down {wait / 60:.0f} min, '
                f'then every {pacer.state.interval:.0f} s')
            sleep(wait)
            first_request = True
    return stats


# --- pace report --------------------------------------------------------------

@dataclass
class PaceReport:
    requests: int
    ok: int
    challenges: int
    errors: int
    # One entry per stretch between challenges: (ok requests, median gap in seconds or None).
    stretches: list[tuple[int, float | None]]
    # Seconds from each challenge to the next successful request.
    recoveries: list[float]


def pace_report(log: list[tuple[float, str, str, int | None, float | None]]) -> PaceReport:
    """Summarize the request log: how many requests passed between challenges, at what gaps."""
    stretches, recoveries = [], []
    ok_gaps: list[float] = []
    ok_count = 0
    challenge_at = None
    counts = {OK: 0, CHALLENGE: 0, ERROR: 0}
    for at, _kind, outcome, _status, gap in log:
        counts[outcome] = counts.get(outcome, 0) + 1
        if outcome == OK:
            ok_count += 1
            if gap is not None:
                ok_gaps.append(gap)
            if challenge_at is not None:
                recoveries.append(at - challenge_at)
                challenge_at = None
        elif outcome == CHALLENGE:
            if challenge_at is None:
                stretches.append((ok_count, statistics.median(ok_gaps) if ok_gaps else None))
                ok_count, ok_gaps = 0, []
                challenge_at = at
    if ok_count:
        stretches.append((ok_count, statistics.median(ok_gaps) if ok_gaps else None))
    return PaceReport(len(log), counts[OK], counts[CHALLENGE], counts[ERROR], stretches, recoveries)
