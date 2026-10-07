"""Scan a folder for the lyrics server: send the lyrics files already have, and ask the
server to fetch the songs that have none. No Picard or Qt imports.

A file is read again only when its size or modification time changed since the last scan
(the scan state). Unchanged files without lyrics are asked for again from the recorded
names; the server answers at once for songs it has cached or queued. A file is recorded
only after the server answered for it, so a scan the server interrupts misses nothing.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
import os

from .scan_state import ScanState
from .server_client import Answer, ServerUnavailable
from .songs import file_ref, song_payload

# Errors kept for the summary; the rest are only counted.
MAX_ERRORS_KEPT = 20


@dataclass
class ScanStats:
    found: int = 0
    unchanged: int = 0
    read: int = 0
    with_lyrics: int = 0
    added: int = 0
    same: int = 0
    replaced: int = 0
    conflicts: int = 0
    not_hebrew: int = 0
    queued: int = 0
    cached: int = 0
    not_found: int = 0
    errors: int = 0
    error_samples: list[tuple[str, str]] = field(default_factory=list)
    conflict_files: list[str] = field(default_factory=list)
    cancelled: bool = False
    server_error: str | None = None


def find_audio_files(root: str, extensions: frozenset[str]) -> Iterator[str]:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            if os.path.splitext(name)[1].lower() in extensions:
                yield os.path.join(dirpath, name)


def _count_put(stats: ScanStats, path: str, answer: Answer) -> str:
    result = str(answer.body.get('result', ''))
    if result in ('added', 'same', 'replaced'):
        setattr(stats, result, getattr(stats, result) + 1)
    elif result == 'conflict':
        stats.conflicts += 1
        stats.conflict_files.append(path)
    elif result == 'not_hebrew':
        stats.not_hebrew += 1
    return result


def _count_fetch(stats: ScanStats, answer: Answer) -> None:
    status = answer.body.get('status')
    if answer.status == 200:
        stats.cached += 1
    elif answer.status == 202:
        stats.queued += 1
    elif status in ('not_hebrew', 'no_name'):
        stats.not_hebrew += 1
    elif status in ('not_found', 'failed'):
        stats.not_found += 1


def scan_folder(
    state: ScanState,
    client,
    root: str,
    read_tags: Callable[[str], object],
    extensions: frozenset[str],
    progress: Callable[[int, int], None] | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> ScanStats:
    """`client` has put(song, lyrics, ref, replace) and fetch(song, priority) (ServerClient).
    `read_tags(path)` returns an object with `artist`, `title` and `lyrics`, or None for an
    unsupported file; an exception it raises counts as an error, and the file is read
    again next time."""
    stats = ScanStats()
    paths = list(find_audio_files(root, extensions))
    stats.found = len(paths)
    for index, path in enumerate(paths, start=1):
        if should_stop and should_stop():
            stats.cancelled = True
            break
        try:
            _scan_one(state, client, path, read_tags, stats)
        except ServerUnavailable as error:
            stats.server_error = str(error)
            break
        if progress:
            progress(index, stats.found)
    return stats


def _scan_one(state: ScanState, client, path: str, read_tags, stats: ScanStats) -> None:
    try:
        st = os.stat(path)
    except OSError as error:
        _record_error(stats, path, error)
        return
    known = state.scanned_file(path, st.st_mtime_ns, st.st_size)
    if known is not None:
        stats.unchanged += 1
        song = song_payload((known.artist, known.title), (None, None), None)
        if not known.has_lyrics and song:
            _count_fetch(stats, client.fetch(song, 'bulk'))
        return

    try:
        tags = read_tags(path)
    except Exception as error:  # any reader failure only skips this file
        _record_error(stats, path, error)
        return
    stats.read += 1
    artist = getattr(tags, 'artist', None) or ''
    title = getattr(tags, 'title', None) or ''
    lyrics = getattr(tags, 'lyrics', None) or ''
    song = song_payload((artist, title), (None, None), None) if tags is not None else None
    has_lyrics = False
    if song and lyrics:
        stats.with_lyrics += 1
        result = _count_put(stats, path, client.put(song, lyrics, file_ref(path), False))
        has_lyrics = result != 'skipped'  # an "instrumental" placeholder is no lyrics
    if song and not has_lyrics:
        _count_fetch(stats, client.fetch(song, 'bulk'))
    # Only now: the server has answered for this file.
    state.mark_scanned(path, st.st_mtime_ns, st.st_size, artist, title, has_lyrics)


def format_summary(stats: ScanStats, folder: str) -> str:
    """Multi-line scan summary for the Picard dialog and the command-line script."""
    lines = [
        f'{"Scan cancelled" if stats.cancelled else "Scan stopped: the lyrics server did not answer" if stats.server_error else "Scan finished"}: {folder}',
        '',
        f'Audio files found: {stats.found}',
        f'Unchanged since last scan: {stats.unchanged}',
        f'Read: {stats.read}, with lyrics: {stats.with_lyrics}',
        f'Lyrics sent to the server: added {stats.added}, same {stats.same}, updated {stats.replaced}',
        f'Conflicts (the server kept its lyrics): {stats.conflicts}',
        f'Not Hebrew (not cached, not fetched): {stats.not_hebrew}',
        f'Songs without lyrics: queued for Shironet {stats.queued}, already on the server {stats.cached}, '
        f'not found on Shironet {stats.not_found}',
        f'Unreadable files: {stats.errors}',
    ]
    if stats.cached:
        lines.append('Lyrics already on the server reach the files through Lookup Lyrics in Picard.')
    if stats.server_error:
        lines += ['', f'Server error: {stats.server_error}', 'Start the server and scan again; nothing scanned so far is lost.']
    return '\n'.join(lines)


def _record_error(stats: ScanStats, path: str, error: BaseException) -> None:
    stats.errors += 1
    if len(stats.error_samples) < MAX_ERRORS_KEPT:
        stats.error_samples.append((path, f'{type(error).__name__}: {error}'))
