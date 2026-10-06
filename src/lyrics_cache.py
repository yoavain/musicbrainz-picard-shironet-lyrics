"""Local SQLite cache of lyrics, keyed by normalized artist and title.

This module has no Picard or Qt imports, so it can be tested with plain Python.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import enum
import os
import re
import sqlite3
import unicodedata


SCHEMA_VERSION = 4

SOURCE_EMBEDDED = 'embedded'
SOURCE_SHIRONET = 'shironet'

# Seconds to wait for a write lock held by another connection (the folder scan
# runs on its own connection while Picard hooks write on the GUI thread).
LOCK_TIMEOUT = 10.0

_SCHEMA = """
CREATE TABLE IF NOT EXISTS lyrics (
    artist_key TEXT NOT NULL,
    title_key  TEXT NOT NULL,
    artist     TEXT NOT NULL,
    title      TEXT NOT NULL,
    lyrics     TEXT NOT NULL,
    source     TEXT NOT NULL,
    source_ref TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (artist_key, title_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS scanned_files (
    path       TEXT PRIMARY KEY,
    mtime_ns   INTEGER NOT NULL,
    size       INTEGER NOT NULL,
    scanned_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shironet_queue (
    artist_key TEXT NOT NULL,
    title_key  TEXT NOT NULL,
    artist     TEXT NOT NULL,
    title      TEXT NOT NULL,
    purpose    TEXT NOT NULL,              -- 'fetch' | 'calibrate'
    status     TEXT NOT NULL,              -- 'pending' | 'done' | 'not_found' | 'failed'
    attempts   INTEGER NOT NULL DEFAULT 0,
    lyrics_url TEXT,                       -- found by search; saves a search on retry
    result     TEXT,                       -- short outcome note
    added_at   TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (artist_key, title_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS shironet_requests (
    id        INTEGER PRIMARY KEY,
    at        REAL NOT NULL,               -- Unix time
    kind      TEXT NOT NULL,               -- 'search' | 'lyrics'
    outcome   TEXT NOT NULL,               -- 'ok' | 'challenge' | 'error'
    http_status INTEGER,
    gap       REAL,                        -- seconds since the previous request
    detail    TEXT
);
"""

# Words that mark a version of a song whose lyrics are the same as the original.
# Hebrew words may carry a one-letter prefix (ב, ה, ו, ל), as in "בהופעה חיה".
_VERSION_WORDS = (
    r'live|remaster(?:ed)?|version|edit|mix|remix|acoustic|unplugged|mono|stereo|demo|bonus'
    r'|[בהול]?(?:הופעה חיה|גרסה|גרסת|רמיקס|לייב|אקוסטי|אקוסטית)'
)
_BRACKET_SUFFIX = re.compile(
    rf'\s*[(\[][^()\[\]]*\b(?:{_VERSION_WORDS})\b[^()\[\]]*[)\]]\s*$', re.IGNORECASE
)
_DASH_SUFFIX = re.compile(rf'\s+-\s+[^-]*\b(?:{_VERSION_WORDS})\b[^-]*$', re.IGNORECASE)
_FEATURING = re.compile(r'\s*[(\[]?\s*\b(?:feat|ft|featuring)\b\.?.*$', re.IGNORECASE)
# Hyphen, Hebrew maqaf (U+05BE), the U+2010-U+2015 dashes, slashes and underscore
# separate words. Built with chr() so the characters stay visible in the source.
_WORD_SEPARATORS = '-' + chr(0x05BE) + ''.join(chr(code) for code in range(0x2010, 0x2016)) + r'/\_'
_SEPARATORS = re.compile('[' + re.escape(_WORD_SEPARATORS) + ']+')
# Hebrew letters (U+05D0-U+05EA) and their presentation forms (U+FB1D-U+FB4F).
_HEBREW_LETTER = re.compile('[%s-%s%s-%s]' % (chr(0x05D0), chr(0x05EA), chr(0xFB1D), chr(0xFB4F)))
_LATIN_LETTER = re.compile('[A-Za-z]')
HEBREW_LANGUAGE_CODES = frozenset({'heb', 'he', 'iw'})

# "heb||" or "eng|None|" before the lyrics: lyricsify-cli wrote FLAC lyrics this way.
_LANGUAGE_PREFIX = re.compile(r'^[A-Za-z]{3}\|[^|]*\|')
# Labels of the credit lines that Shironet puts above the lyrics.
_CREDIT_WORDS = (
    r'(?:ביצוע|מילים|לחן|עיבוד|תרגום|הפקה|גירסה עברית|גרסה עברית|נוסח עברי'
    r'|performed by|arrangement|lyrics|music|words)'
)
# "מילים: ...", "מילים ולחן: ...", "לחן, עיבוד: ...".
_CREDIT_LINE = re.compile(
    rf'^\s*{_CREDIT_WORDS}(?:\s*,\s*{_CREDIT_WORDS}|\s+ו{_CREDIT_WORDS})*\s*:', re.IGNORECASE
)
# Credit lines are looked for only near the top. Lower down, "someone said:" lines are lyrics.
CREDIT_SEARCH_LINES = 8
_INSTRUMENTAL = re.compile(r'^[(\[]?\s*(?:instrumental|אינסטרומנטלי|אינסטרומנטל)\s*[)\]]?\.?$', re.IGNORECASE)
# A placeholder is the "instrumental" line plus at most a note or two.
INSTRUMENTAL_MAX_LINES = 3
_WHITESPACE = re.compile(r'\s+')


class PutResult(enum.Enum):
    ADDED = 'added'
    UNCHANGED = 'unchanged'
    REPLACED = 'replaced'
    # Different lyrics from another source are already stored; they were kept.
    CONFLICT = 'conflict'
    # Artist, title or lyrics is empty after normalization.
    SKIPPED = 'skipped'


@dataclass(frozen=True)
class Entry:
    artist: str
    title: str
    lyrics: str
    source: str
    source_ref: str | None
    updated_at: str


def normalize(text: str | None) -> str:
    """Return the matching form of an artist or title.

    Drops diacritics (including niqqud), "feat." parts, version suffixes such as
    "(Live)" or "- Remastered 2011", and punctuation. Lowercases Latin text.
    """
    if not text:
        return ''
    text = unicodedata.normalize('NFKD', text)
    text = ''.join(ch for ch in text if not unicodedata.category(ch).startswith('M'))
    text = text.casefold()
    text = _FEATURING.sub('', text)
    previous = None
    while previous != text:
        previous = text
        text = _BRACKET_SUFFIX.sub('', text)
        text = _DASH_SUFFIX.sub('', text)
    text = _SEPARATORS.sub(' ', text)
    text = ''.join(ch for ch in text if unicodedata.category(ch)[0] not in 'PS')
    text = _WHITESPACE.sub(' ', text).strip()
    return unicodedata.normalize('NFC', text)


def has_hebrew(text: str | None) -> bool:
    return bool(text and _HEBREW_LETTER.search(text))


def is_hebrew_song(*names: str | None, lyrics: str | None = None, language: str | None = None) -> bool:
    """Decide whether a song is Hebrew, so that Shironet is the right source for it.

    A song is Hebrew when any of `names` (artist, title) contains a Hebrew letter,
    when `language` is a Hebrew language code, or when `lyrics` hold more Hebrew
    letters than Latin letters.
    """
    if any(has_hebrew(name) for name in names):
        return True
    if language and language.strip().lower() in HEBREW_LANGUAGE_CODES:
        return True
    if lyrics:
        return len(_HEBREW_LETTER.findall(lyrics)) > len(_LATIN_LETTER.findall(lyrics))
    return False


def cache_key(artist: str | None, title: str | None) -> tuple[str, str]:
    return normalize(artist), normalize(title)


def normalize_path(path: str) -> str:
    """Return the form of a file path stored in `scanned_files` and `source_ref`."""
    return os.path.normcase(os.path.abspath(path))


def clean_lyrics(text: str | None) -> str:
    """Return the lyrics without the parts that are not lyrics.

    Normalizes line endings, trims trailing spaces and outer blank lines, removes a
    "heb||"-style language prefix, and removes a title-and-credits header: every line
    up to the last credit line ("ביצוע:", "מילים:", "לחן:" ...) among the first
    CREDIT_SEARCH_LINES lines. Returns '' for an "instrumental" placeholder.
    """
    if not text:
        return ''
    text = _LANGUAGE_PREFIX.sub('', text.lstrip())
    lines = [line.rstrip() for line in text.replace('\r\n', '\n').replace('\r', '\n').split('\n')]
    credit_lines = [index for index, line in enumerate(lines[:CREDIT_SEARCH_LINES]) if _CREDIT_LINE.match(line)]
    if credit_lines:
        lines = lines[credit_lines[-1] + 1:]
    text = '\n'.join(lines).strip()
    filled = [line for line in text.split('\n') if line.strip()]
    if filled and len(filled) <= INSTRUMENTAL_MAX_LINES and _INSTRUMENTAL.match(filled[0].strip()):
        return ''
    return text


def embedded_lyrics(metadata) -> str:
    """Return the unsynced lyrics stored in Picard file metadata, or ''.

    Picard reads unsynced lyrics into the `lyrics` tag, and ID3 USLT frames
    that have a description into `lyrics:<description>`. Plain `lyrics` wins.
    """
    names = ['lyrics'] + sorted(name for name in metadata.keys() if name.startswith('lyrics:'))
    for name in names:
        for value in metadata.getall(name):
            text = clean_lyrics(value)
            if text:
                return text
    return ''


class LyricsCache:
    def __init__(self, path: str):
        # Autocommit mode: each statement commits on its own unless batch() is active.
        self._conn = sqlite3.connect(path, isolation_level=None, timeout=LOCK_TIMEOUT)
        self._in_batch = False
        # (updated, deleted) rows when opening ran the version 3 cleanup, else None.
        self.cleanup_counts: tuple[int, int] | None = None
        try:
            if path != ':memory:':
                self._conn.execute('PRAGMA journal_mode=WAL')
            self._conn.executescript(_SCHEMA)
            self._migrate()
        except BaseException:
            self._conn.close()
            raise

    def _migrate(self) -> None:
        # The version is read inside the write transaction, so when the plugin and
        # the script open an old cache at the same time, only one of them migrates.
        with self.batch():
            row = self._conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
            version = SCHEMA_VERSION if row is None else int(row[0])
            if version > SCHEMA_VERSION:
                raise RuntimeError(
                    f'Lyrics cache schema version {version} is newer than supported version {SCHEMA_VERSION}'
                )
            # Version 2 only added the scanned_files table, which _SCHEMA creates.
            # Version 3 made clean_lyrics() remove prefixes, credits and placeholders.
            # Version 4 only added the shironet_queue and shironet_requests tables.
            if version < 3:
                self.cleanup_counts = self._clean_stored_lyrics()
            if row is None or version < SCHEMA_VERSION:
                self._conn.execute(
                    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
                    (str(SCHEMA_VERSION),),
                )

    def _clean_stored_lyrics(self) -> tuple[int, int]:
        """Apply clean_lyrics() to every stored row. Returns (updated, deleted)."""
        updated = deleted = 0
        rows = self._conn.execute('SELECT artist_key, title_key, lyrics FROM lyrics').fetchall()
        for artist_key, title_key, lyrics in rows:
            cleaned = clean_lyrics(lyrics)
            if cleaned == lyrics:
                continue
            if cleaned:
                self._conn.execute(
                    'UPDATE lyrics SET lyrics = ?, updated_at = ? WHERE artist_key = ? AND title_key = ?',
                    (cleaned, _now(), artist_key, title_key),
                )
                updated += 1
            else:
                self._conn.execute(
                    'DELETE FROM lyrics WHERE artist_key = ? AND title_key = ?', (artist_key, title_key)
                )
                deleted += 1
        return updated, deleted

    def close(self) -> None:
        self._conn.close()

    @property
    def connection(self) -> sqlite3.Connection:
        """The connection, for the Shironet queue (shironet_queue.py) on the same file."""
        return self._conn

    def get_meta(self, key: str, default: str | None = None) -> str | None:
        row = self._conn.execute('SELECT value FROM meta WHERE key = ?', (key,)).fetchone()
        return row[0] if row else default

    def set_meta(self, key: str, value: str) -> None:
        self._conn.execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', (key, value))

    @contextmanager
    def batch(self) -> Iterator[None]:
        """Run many writes in one transaction."""
        if self._in_batch:
            yield
            return
        # IMMEDIATE takes the write lock up front, so a second connection waits
        # for it (up to LOCK_TIMEOUT) instead of failing on a lock upgrade.
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

    def get(self, artist: str | None, title: str | None) -> Entry | None:
        artist_key, title_key = cache_key(artist, title)
        if not artist_key or not title_key:
            return None
        row = self._conn.execute(
            'SELECT artist, title, lyrics, source, source_ref, updated_at FROM lyrics '
            'WHERE artist_key = ? AND title_key = ?',
            (artist_key, title_key),
        ).fetchone()
        return Entry(*row) if row else None

    def lookup(self, names: Iterable[tuple[str | None, str | None]]) -> Entry | None:
        """Return the entry for the first (artist, title) in `names` that is cached."""
        for artist, title in names:
            entry = self.get(artist, title)
            if entry is not None:
                return entry
        return None

    def put(
        self,
        artist: str | None,
        title: str | None,
        lyrics: str | None,
        source: str,
        source_ref: str | None = None,
        replace: bool = False,
    ) -> PutResult:
        """Store lyrics for an artist and title.

        Different lyrics already stored for the key are kept (CONFLICT), unless
        `replace` is set or they came from the same `source_ref`. The second case
        is a file whose own lyrics changed since it was last read.
        """
        artist_key, title_key = cache_key(artist, title)
        lyrics = clean_lyrics(lyrics)
        if not artist_key or not title_key or not lyrics:
            return PutResult.SKIPPED

        row = self._conn.execute(
            'SELECT lyrics, source_ref FROM lyrics WHERE artist_key = ? AND title_key = ?',
            (artist_key, title_key),
        ).fetchone()
        if row is not None:
            stored_lyrics, stored_ref = row
            if stored_lyrics == lyrics:
                return PutResult.UNCHANGED
            same_source = source_ref is not None and stored_ref == source_ref
            if not replace and not same_source:
                return PutResult.CONFLICT

        self._conn.execute(
            'INSERT OR REPLACE INTO lyrics '
            '(artist_key, title_key, artist, title, lyrics, source, source_ref, updated_at) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (artist_key, title_key, artist.strip(), title.strip(), lyrics, source, source_ref, _now()),
        )
        return PutResult.ADDED if row is None else PutResult.REPLACED

    def put_file_lyrics(
        self,
        names: Iterable[tuple[str | None, str | None]],
        lyrics: str,
        path: str,
        replace: bool = False,
    ) -> list[PutResult]:
        """Store one file's lyrics under each distinct (artist, title) in `names`."""
        source_ref = normalize_path(path)
        results = []
        seen = set()
        for artist, title in names:
            key = cache_key(artist, title)
            if key in seen:
                continue
            seen.add(key)
            results.append(self.put(artist, title, lyrics, SOURCE_EMBEDDED, source_ref, replace))
        return results

    def is_scanned(self, path: str, mtime_ns: int, size: int) -> bool:
        """True when the file was read before and has not changed since."""
        row = self._conn.execute(
            'SELECT mtime_ns, size FROM scanned_files WHERE path = ?', (normalize_path(path),)
        ).fetchone()
        return row == (mtime_ns, size)

    def mark_scanned(self, path: str, mtime_ns: int, size: int) -> None:
        self._conn.execute(
            'INSERT OR REPLACE INTO scanned_files (path, mtime_ns, size, scanned_at) VALUES (?, ?, ?, ?)',
            (normalize_path(path), mtime_ns, size, _now()),
        )

    def count(self) -> int:
        return self._conn.execute('SELECT COUNT(*) FROM lyrics').fetchone()[0]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')
