"""What the folder scan already read: one row per file (size, modification time, the tags
it found), in its own small SQLite file. No lyrics are stored here; the server owns them.
No Picard or Qt imports.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import os
import sqlite3

STATE_FILE = 'scan-state.sqlite3'
# The plugin and scripts/scan_folder.py may write at the same time.
LOCK_TIMEOUT = 10.0

_SCHEMA = """
CREATE TABLE IF NOT EXISTS scanned_files (
    path       TEXT PRIMARY KEY,
    mtime_ns   INTEGER NOT NULL,
    size       INTEGER NOT NULL,
    scanned_at TEXT NOT NULL,
    artist     TEXT,
    title      TEXT,
    has_lyrics INTEGER
) WITHOUT ROWID;
"""


@dataclass(frozen=True)
class ScannedFile:
    artist: str
    title: str
    has_lyrics: bool


def normalize_path(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


class ScanState:
    def __init__(self, path: str):
        self._conn = sqlite3.connect(path, isolation_level=None, timeout=LOCK_TIMEOUT)
        self._in_batch = False
        self.copied_from_old_cache = 0
        if path != ':memory:':
            self._conn.execute('PRAGMA journal_mode=WAL')
        self._conn.executescript(_SCHEMA)

    @classmethod
    def open(cls, path: str, old_cache: str | None = None) -> ScanState:
        """Opens the state file. A new file first takes the scanned files of the old
        plugin cache (read-only), so the first scan reads only new and changed files."""
        is_new = not os.path.exists(path)
        state = cls(path)
        if is_new and old_cache and os.path.exists(old_cache):
            try:
                state.copied_from_old_cache = state._copy_from(old_cache)
            except sqlite3.Error:
                state.copied_from_old_cache = 0  # a full rescan then; nothing is lost
        return state

    def _copy_from(self, old_cache: str) -> int:
        uri = 'file:' + old_cache.replace('\\', '/') + '?mode=ro'
        old = sqlite3.connect(uri, uri=True, timeout=LOCK_TIMEOUT)
        try:
            rows = old.execute(
                'SELECT path, mtime_ns, size, scanned_at, artist, title, has_lyrics FROM scanned_files'
            ).fetchall()
        finally:
            old.close()
        with self.batch():
            self._conn.executemany(
                'INSERT OR IGNORE INTO scanned_files (path, mtime_ns, size, scanned_at, artist, title, has_lyrics) '
                'VALUES (?, ?, ?, ?, ?, ?, ?)',
                rows,
            )
        return len(rows)

    def close(self) -> None:
        self._conn.close()

    @contextmanager
    def batch(self) -> Iterator[None]:
        """Many writes in one transaction."""
        if self._in_batch:
            yield
            return
        self._conn.execute('BEGIN IMMEDIATE')
        self._in_batch = True
        try:
            yield
        except BaseException:
            self._conn.execute('ROLLBACK')
            raise
        else:
            self._conn.execute('COMMIT')
        finally:
            self._in_batch = False

    def scanned_file(self, path: str, mtime_ns: int, size: int) -> ScannedFile | None:
        """What an earlier read found, when the file has not changed since. None when the
        file was never read, changed, or was read without recording whether it had lyrics."""
        row = self._conn.execute(
            'SELECT mtime_ns, size, artist, title, has_lyrics FROM scanned_files WHERE path = ?',
            (normalize_path(path),),
        ).fetchone()
        if row is None or row[:2] != (mtime_ns, size) or row[4] is None:
            return None
        return ScannedFile(row[2] or '', row[3] or '', bool(row[4]))

    def mark_scanned(
        self, path: str, mtime_ns: int, size: int,
        artist: str | None = None, title: str | None = None, has_lyrics: bool | None = None,
    ) -> None:
        self._conn.execute(
            'INSERT OR REPLACE INTO scanned_files (path, mtime_ns, size, scanned_at, artist, title, has_lyrics) '
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            (normalize_path(path), mtime_ns, size, _now(), artist, title,
             None if has_lyrics is None else int(has_lyrics)),
        )
