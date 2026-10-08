"""HTTP client for the Shironet lyrics server. No Picard or Qt imports.

Blocking calls with a timeout: the plugin runs them on worker threads, the folder scan
on its own thread. Not Picard's web service: Picard rate-limits every host it does not
know to one request per second.

Text rules (see the server spec, "Hebrew text"): JSON bodies in raw UTF-8, never in the
URL; responses decoded as UTF-8; error bodies (404, 422) are read like any other.

A server on the LAN needs its token (the server's LYRICS_SERVER_TOKEN): `Authorization: Bearer <token>` on every call.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import urllib.error
import urllib.request

DEFAULT_SERVER_URL = 'http://127.0.0.1:8735'


@dataclass(frozen=True)
class Answer:
    status: int
    body: dict


class ServerUnavailable(Exception):
    """The server did not answer, or answered something that is not JSON."""


class Unauthorized(ServerUnavailable):
    """The server refused the token (missing or wrong). Callers stop as for a server that is down."""


def _without_nulls(value: dict) -> dict:
    return {key: item for key, item in value.items() if item is not None}


class ServerClient:
    def __init__(self, base_url: str = DEFAULT_SERVER_URL, timeout: float = 10.0, token: str | None = None):
        self.base_url = base_url.rstrip('/')
        self.timeout = timeout
        self.token = (token or '').strip() or None

    def _call(self, method: str, path: str, body: dict | None = None) -> Answer:
        data = None
        headers = {'Accept': 'application/json'}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'
        if body is not None:
            data = json.dumps(_without_nulls(body), ensure_ascii=False).encode('utf-8')
            headers['Content-Type'] = 'application/json; charset=utf-8'
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as reply:
                status, raw = reply.status, reply.read()
        except urllib.error.HTTPError as error:
            status, raw = error.code, error.read()
            if status == 401:
                raise Unauthorized(f'{self.base_url}: the server refused the token (missing or wrong)') from error
        except (urllib.error.URLError, OSError) as error:
            raise ServerUnavailable(f'{self.base_url}: {error}') from error
        try:
            parsed = json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, ValueError) as error:
            raise ServerUnavailable(f'{self.base_url}{path}: answer {status} is not JSON') from error
        if not isinstance(parsed, dict):
            raise ServerUnavailable(f'{self.base_url}{path}: answer {status} is not a JSON object')
        return Answer(status, parsed)

    def health(self) -> Answer:
        return self._call('GET', '/health')

    def status(self) -> Answer:
        """Queue and pace. Needs the token (unlike /health), so it also checks the token."""
        return self._call('GET', '/status')

    def lookup(self, song: dict) -> Answer:
        """Cached lyrics, or 404. Never queues."""
        return self._call('POST', '/lyrics/lookup', _without_nulls(song))

    def fetch(self, song: dict, priority: str) -> Answer:
        """Cached lyrics (200), or the queue state (202 queued/fetching, 404 not found, 422)."""
        return self._call('POST', '/lyrics/fetch', {**_without_nulls(song), 'priority': priority})

    def put(self, song: dict, lyrics: str, ref: str | None, replace: bool) -> Answer:
        """Lyrics a file already has, in any language. Answers {result: added|same|replaced|conflict|skipped}."""
        return self._call('PUT', '/lyrics', {**_without_nulls(song), 'lyrics': lyrics, 'ref': ref, 'replace': replace})

    def requeue_not_found(self) -> int:
        return int(self._call('POST', '/admin/requeue-not-found', {}).body.get('count', 0))
