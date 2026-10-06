"""Scan a folder: store the lyrics embedded in its audio files, and queue the
Hebrew songs that have none for the Shironet worker.

A file is read again only when its size or modification time changed since the
last scan, so a rescan of a large library is quick. What each read found (artist,
title, lyrics or not) is recorded, so unchanged files without lyrics are queued
from the database. No Picard or Qt imports.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
import os

from .lyrics_cache import LyricsCache, PutResult, is_hebrew_song
from . import shironet_queue as queue


# Files read before their results are written in one transaction. Tags are read
# outside the transaction, so Picard's own writes wait only for short commits.
BATCH_SIZE = 200

# Errors kept for the summary; the rest are only counted.
MAX_ERRORS_KEPT = 20


@dataclass
class ScanStats:
    found: int = 0
    unchanged: int = 0
    read: int = 0
    with_lyrics: int = 0
    not_hebrew: int = 0
    added: int = 0
    replaced: int = 0
    conflicts: int = 0
    skipped: int = 0
    queued: int = 0
    errors: int = 0
    error_samples: list[tuple[str, str]] = field(default_factory=list)
    conflict_files: list[str] = field(default_factory=list)
    cancelled: bool = False

    def count(self, results: list[PutResult]) -> None:
        self.added += results.count(PutResult.ADDED)
        self.replaced += results.count(PutResult.REPLACED)
        self.conflicts += results.count(PutResult.CONFLICT)
        self.skipped += results.count(PutResult.SKIPPED)


def find_audio_files(root: str, extensions: frozenset[str]) -> Iterator[str]:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            if os.path.splitext(name)[1].lower() in extensions:
                yield os.path.join(dirpath, name)


def scan_folder(
    cache: LyricsCache,
    root: str,
    read_tags: Callable[[str], object],
    extensions: frozenset[str],
    progress: Callable[[int, int], None] | None = None,
    should_stop: Callable[[], bool] | None = None,
    queue_missing: bool = True,
) -> ScanStats:
    """Store the lyrics of new and changed Hebrew songs under `root`, and queue the
    Hebrew songs without lyrics (new, changed or unchanged files) for Shironet.

    `read_tags(path)` returns an object with `artist`, `title` and `lyrics`, or
    None for an unsupported file. Exceptions it raises are counted as errors,
    and that file is retried on the next scan.
    """
    stats = ScanStats()
    paths = list(find_audio_files(root, extensions))
    stats.found = len(paths)

    read_files = []  # (path, stat, tags) to store
    missing = []  # (artist, title) of unchanged files without lyrics
    for index, path in enumerate(paths, start=1):
        if should_stop and should_stop():
            stats.cancelled = True
            break
        try:
            st = os.stat(path)
        except OSError as exc:
            _record_error(stats, path, exc)
            continue
        known = cache.scanned_file(path, st.st_mtime_ns, st.st_size)
        if known is not None:
            stats.unchanged += 1
            if queue_missing and not known.has_lyrics:
                missing.append((known.artist, known.title))
        else:
            try:
                tags = read_tags(path)
            except Exception as exc:  # any reader failure only skips this file
                _record_error(stats, path, exc)
            else:
                stats.read += 1
                read_files.append((path, st, tags))
        if len(read_files) + len(missing) >= BATCH_SIZE:
            _write(cache, read_files, missing, stats, queue_missing)
        if progress:
            progress(index, stats.found)

    _write(cache, read_files, missing, stats, queue_missing)
    return stats


def _write(cache: LyricsCache, read_files: list, missing: list, stats: ScanStats, queue_missing: bool) -> None:
    if not read_files and not missing:
        return
    with cache.batch():
        for path, st, tags in read_files:
            artist = getattr(tags, 'artist', None)
            title = getattr(tags, 'title', None)
            lyrics = getattr(tags, 'lyrics', None)
            if lyrics:
                stats.with_lyrics += 1
                if is_hebrew_song(artist, title, lyrics=lyrics):
                    results = cache.put_file_lyrics([(artist, title)], lyrics, path)
                    stats.count(results)
                    if PutResult.CONFLICT in results:
                        stats.conflict_files.append(path)
                else:
                    stats.not_hebrew += 1
            elif tags is not None and queue_missing:
                _queue(cache, artist, title, stats)
            # An unknown format counts as "no lyrics": it has no name, so it is never queued.
            cache.mark_scanned(path, st.st_mtime_ns, st.st_size, artist, title, bool(lyrics))
        for artist, title in missing:
            _queue(cache, artist, title, stats)
    read_files.clear()
    missing.clear()


def _queue(cache: LyricsCache, artist: str | None, title: str | None, stats: ScanStats) -> None:
    if artist and title and is_hebrew_song(artist, title) and queue.enqueue(cache, artist, title):
        stats.queued += 1


def format_summary(stats: ScanStats, folder: str, cache_count: int | None) -> str:
    """Multi-line scan summary for the Picard dialog and the command-line script."""
    lines = [
        f'{"Scan cancelled" if stats.cancelled else "Scan finished"}: {folder}',
        '',
        f'Audio files found: {stats.found}',
        f'Unchanged since last scan: {stats.unchanged}',
        f'Read: {stats.read}, with lyrics: {stats.with_lyrics}',
        f'Not Hebrew (not cached): {stats.not_hebrew}',
        f'Added: {stats.added}, updated: {stats.replaced}',
        f'Conflicts (kept cached lyrics): {stats.conflicts}',
        f'Skipped (no artist or title): {stats.skipped}',
        f'Unreadable files: {stats.errors}',
        f'Hebrew songs without lyrics, newly queued for Shironet: {stats.queued}',
        '',
        f'Cache now holds {"?" if cache_count is None else cache_count} songs.',
    ]
    return '\n'.join(lines)


def _record_error(stats: ScanStats, path: str, exc: BaseException) -> None:
    stats.errors += 1
    if len(stats.error_samples) < MAX_ERRORS_KEPT:
        stats.error_samples.append((path, f'{type(exc).__name__}: {exc}'))
