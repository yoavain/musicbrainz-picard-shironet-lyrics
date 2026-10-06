"""Scan a folder and store the lyrics embedded in its audio files.

A file is read again only when its size or modification time changed since the
last scan, so a rescan of a large library is quick. No Picard or Qt imports.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
import os

from .lyrics_cache import LyricsCache, PutResult, is_hebrew_song


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
) -> ScanStats:
    """Store the lyrics of new and changed Hebrew songs under `root`.

    `read_tags(path)` returns an object with `artist`, `title` and `lyrics`, or
    None for an unsupported file. Exceptions it raises are counted as errors,
    and that file is retried on the next scan.
    """
    stats = ScanStats()
    paths = list(find_audio_files(root, extensions))
    stats.found = len(paths)

    pending = []
    for index, path in enumerate(paths, start=1):
        if should_stop and should_stop():
            stats.cancelled = True
            break
        try:
            st = os.stat(path)
        except OSError as exc:
            _record_error(stats, path, exc)
            continue
        if cache.is_scanned(path, st.st_mtime_ns, st.st_size):
            stats.unchanged += 1
        else:
            try:
                tags = read_tags(path)
            except Exception as exc:  # any reader failure only skips this file
                _record_error(stats, path, exc)
            else:
                stats.read += 1
                pending.append((path, st, tags))
        if len(pending) >= BATCH_SIZE:
            _write(cache, pending, stats)
        if progress:
            progress(index, stats.found)

    _write(cache, pending, stats)
    return stats


def _write(cache: LyricsCache, pending: list, stats: ScanStats) -> None:
    if not pending:
        return
    with cache.batch():
        for path, st, tags in pending:
            if tags is not None and tags.lyrics:
                stats.with_lyrics += 1
                if is_hebrew_song(tags.artist, tags.title, lyrics=tags.lyrics):
                    results = cache.put_file_lyrics([(tags.artist, tags.title)], tags.lyrics, path)
                    stats.count(results)
                    if PutResult.CONFLICT in results:
                        stats.conflict_files.append(path)
                else:
                    stats.not_hebrew += 1
            cache.mark_scanned(path, st.st_mtime_ns, st.st_size)
    pending.clear()


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
        '',
        f'Cache now holds {"?" if cache_count is None else cache_count} songs.',
    ]
    return '\n'.join(lines)


def _record_error(stats: ScanStats, path: str, exc: BaseException) -> None:
    stats.errors += 1
    if len(stats.error_samples) < MAX_ERRORS_KEPT:
        stats.error_samples.append((path, f'{type(exc).__name__}: {exc}'))
