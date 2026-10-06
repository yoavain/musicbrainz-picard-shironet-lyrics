"""The queue of songs to fetch from Shironet, and the log of requests sent to it.

Both are tables in the lyrics cache file. No Picard or Qt imports.

Purposes:
- 'fetch': a song with no cached lyrics. Fetched lyrics go into the cache.
- 'calibrate': a song that is already cached. Fetched lyrics are only compared
  with the cached ones, to measure the parser and matching on known answers.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
import time

from .lyrics_cache import LyricsCache, _now, cache_key


PURPOSE_FETCH = 'fetch'
PURPOSE_CALIBRATE = 'calibrate'

PENDING = 'pending'
DONE = 'done'
NOT_FOUND = 'not_found'
FAILED = 'failed'


@dataclass(frozen=True)
class QueueItem:
    artist: str
    title: str
    purpose: str
    attempts: int
    lyrics_url: str | None
    alt_artist: str | None = None
    alt_title: str | None = None

    def names(self) -> list[tuple[str, str]]:
        """The primary name, then the alternate name when there is one."""
        names = [(self.artist, self.title)]
        if self.alt_artist and self.alt_title:
            names.append((self.alt_artist, self.alt_title))
        return names


def enqueue(
    cache: LyricsCache,
    artist: str,
    title: str,
    purpose: str = PURPOSE_FETCH,
    alternate: tuple[str | None, str | None] | None = None,
) -> bool:
    """Add a song as pending. Returns False when it is already queued (any status)
    or has an empty key, or, for 'fetch', when it is already cached under either name.

    `alternate` is a second (artist, title) to match exactly, for example the
    MusicBrainz name of a file whose own tags give (artist, title). It is kept only
    when its key differs from the primary key.
    """
    artist_key, title_key = cache_key(artist, title)
    if not artist_key or not title_key:
        return False
    alt_artist = alt_title = None
    if alternate is not None:
        alt_key = cache_key(*alternate)
        if all(alt_key) and alt_key != (artist_key, title_key):
            alt_artist, alt_title = alternate[0].strip(), alternate[1].strip()
    if purpose == PURPOSE_FETCH:
        if cache.get(artist, title) is not None:
            return False
        if alt_title is not None and cache.get(alt_artist, alt_title) is not None:
            return False
    cursor = cache.connection.execute(
        'INSERT OR IGNORE INTO shironet_queue '
        '(artist_key, title_key, artist, title, purpose, status, alt_artist, alt_title, added_at, updated_at) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (artist_key, title_key, artist.strip(), title.strip(), purpose, PENDING, alt_artist, alt_title,
         _now(), _now()),
    )
    return cursor.rowcount == 1


def _due_condition() -> str:
    # Pending songs, plus songs not found or failed whose retry time has passed.
    return f"(status = '{PENDING}' OR (status IN ('{NOT_FOUND}', '{FAILED}') AND retry_after <= ?))"


def next_pending(cache: LyricsCache, now: str | None = None) -> QueueItem | None:
    """The next song to fetch: pending songs first (fewest attempts, oldest first),
    then songs not found or failed whose retry time has passed."""
    row = cache.connection.execute(
        'SELECT artist, title, purpose, attempts, lyrics_url, alt_artist, alt_title FROM shironet_queue '
        f'WHERE {_due_condition()} ORDER BY status != ?, attempts, added_at LIMIT 1',
        (now or _now(), PENDING),
    ).fetchone()
    return QueueItem(*row) if row else None


def due_count(cache: LyricsCache, now: str | None = None) -> int:
    """How many songs next_pending() would return, one after the other."""
    return cache.connection.execute(
        f'SELECT COUNT(*) FROM shironet_queue WHERE {_due_condition()}', (now or _now(),)
    ).fetchone()[0]


def requeue(cache: LyricsCache, status: str = NOT_FOUND, purpose: str = PURPOSE_FETCH) -> int:
    """Set songs with `status` back to pending now, without waiting for their retry time."""
    cursor = cache.connection.execute(
        'UPDATE shironet_queue SET status = ?, attempts = 0, lyrics_url = NULL, retry_after = NULL, '
        'updated_at = ? WHERE status = ? AND purpose = ?',
        (PENDING, _now(), status, purpose),
    )
    return cursor.rowcount


def misses(
    cache: LyricsCache, purpose: str = PURPOSE_FETCH
) -> list[tuple[str, str, str | None, str | None, str | None, str | None]]:
    """(artist, title, alt_artist, alt_title, result, retry_after) of songs not found, oldest first."""
    return cache.connection.execute(
        'SELECT artist, title, alt_artist, alt_title, result, retry_after FROM shironet_queue '
        'WHERE status = ? AND purpose = ? ORDER BY updated_at',
        (NOT_FOUND, purpose),
    ).fetchall()


def update(
    cache: LyricsCache,
    item: QueueItem,
    status: str | None = None,
    result: str | None = None,
    lyrics_url: str | None = None,
    add_attempt: bool = False,
    retry_after: str | None = None,
) -> None:
    artist_key, title_key = cache_key(item.artist, item.title)
    cache.connection.execute(
        'UPDATE shironet_queue SET '
        'status = COALESCE(?, status), result = COALESCE(?, result), '
        'lyrics_url = COALESCE(?, lyrics_url), retry_after = COALESCE(?, retry_after), '
        'attempts = attempts + ?, updated_at = ? '
        'WHERE artist_key = ? AND title_key = ?',
        (status, result, lyrics_url, retry_after, 1 if add_attempt else 0, _now(), artist_key, title_key),
    )


def counts(cache: LyricsCache) -> dict[tuple[str, str], int]:
    """{(purpose, status): count}."""
    return {
        (purpose, status): count
        for purpose, status, count in cache.connection.execute(
            'SELECT purpose, status, COUNT(*) FROM shironet_queue GROUP BY purpose, status'
        )
    }


def results(cache: LyricsCache, purpose: str) -> list[tuple[str, str, str, str | None]]:
    """(artist, title, status, result) of every song with this purpose."""
    return cache.connection.execute(
        'SELECT artist, title, status, result FROM shironet_queue WHERE purpose = ? ORDER BY updated_at',
        (purpose,),
    ).fetchall()


def log_request(
    cache: LyricsCache,
    kind: str,
    outcome: str,
    http_status: int | None,
    detail: str | None = None,
    at: float | None = None,
) -> None:
    at = time.time() if at is None else at
    previous = cache.connection.execute('SELECT MAX(at) FROM shironet_requests').fetchone()[0]
    cache.connection.execute(
        'INSERT INTO shironet_requests (at, kind, outcome, http_status, gap, detail) VALUES (?, ?, ?, ?, ?, ?)',
        (at, kind, outcome, http_status, None if previous is None else at - previous, detail),
    )


def request_log(cache: LyricsCache) -> list[tuple[float, str, str, int | None, float | None]]:
    """(at, kind, outcome, http_status, gap) of every request, oldest first."""
    return cache.connection.execute(
        'SELECT at, kind, outcome, http_status, gap FROM shironet_requests ORDER BY at'
    ).fetchall()


def outcome_counts(cache: LyricsCache) -> Counter:
    return Counter(dict(cache.connection.execute(
        'SELECT outcome, COUNT(*) FROM shironet_requests GROUP BY outcome'
    ).fetchall()))
