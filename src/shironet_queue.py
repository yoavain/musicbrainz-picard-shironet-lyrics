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


def enqueue(cache: LyricsCache, artist: str, title: str, purpose: str = PURPOSE_FETCH) -> bool:
    """Add a song as pending. Returns False when it is already queued (any status)
    or has an empty key, or, for 'fetch', when it is already cached."""
    artist_key, title_key = cache_key(artist, title)
    if not artist_key or not title_key:
        return False
    if purpose == PURPOSE_FETCH and cache.get(artist, title) is not None:
        return False
    cursor = cache.connection.execute(
        'INSERT OR IGNORE INTO shironet_queue '
        '(artist_key, title_key, artist, title, purpose, status, added_at, updated_at) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        (artist_key, title_key, artist.strip(), title.strip(), purpose, PENDING, _now(), _now()),
    )
    return cursor.rowcount == 1


def next_pending(cache: LyricsCache) -> QueueItem | None:
    """The pending song with the fewest attempts, oldest first."""
    row = cache.connection.execute(
        'SELECT artist, title, purpose, attempts, lyrics_url FROM shironet_queue '
        'WHERE status = ? ORDER BY attempts, added_at LIMIT 1',
        (PENDING,),
    ).fetchone()
    return QueueItem(*row) if row else None


def update(
    cache: LyricsCache,
    item: QueueItem,
    status: str | None = None,
    result: str | None = None,
    lyrics_url: str | None = None,
    add_attempt: bool = False,
) -> None:
    artist_key, title_key = cache_key(item.artist, item.title)
    cache.connection.execute(
        'UPDATE shironet_queue SET '
        'status = COALESCE(?, status), result = COALESCE(?, result), '
        'lyrics_url = COALESCE(?, lyrics_url), attempts = attempts + ?, updated_at = ? '
        'WHERE artist_key = ? AND title_key = ?',
        (status, result, lyrics_url, 1 if add_attempt else 0, _now(), artist_key, title_key),
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
