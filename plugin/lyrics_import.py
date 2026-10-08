"""Import the lyrics that audio files already have into the lyrics server, in any language.
The reverse of the Plex export (lyrics_export.py). No Picard or Qt imports.

Every file is read; the scan state is neither read nor written. The lyrics come from the
tags, else from a .txt or .lrc sidecar next to the file (a .lrc loses its time tags: the
cache keeps plain text). They go to the server as PUT /lyrics with replace off, so the
cache keeps its lyrics on a conflict. Nothing is queued for Shironet. A second run gives
"same" for everything sent before.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from .lyrics_text import LRC, TXT, is_lrc, lrc_to_plain, sidecar_path
from .scanner import find_audio_files
from .server_client import ServerUnavailable
from .songs import file_ref, song_payload

# Errors kept for the summary; the rest are only counted.
MAX_ERRORS_KEPT = 20


@dataclass
class ImportStats:
    found: int = 0
    read: int = 0
    from_tags: int = 0
    from_sidecar: int = 0
    added: int = 0
    same: int = 0
    replaced: int = 0
    conflicts: int = 0
    skipped: int = 0  # the server found no lyrics after cleaning ("instrumental")
    no_lyrics: int = 0
    no_name: int = 0
    unsupported: int = 0
    errors: int = 0
    error_samples: list[tuple[str, str]] = field(default_factory=list)
    conflict_files: list[str] = field(default_factory=list)
    cancelled: bool = False
    server_error: str | None = None


def sidecar_lyrics(audio_path: str) -> str:
    """The lyrics of the .txt or .lrc sidecar next to the audio file, as plain text; ''
    when there is none. Raises OSError or UnicodeDecodeError (UTF-8 only)."""
    for kind in (TXT, LRC):
        try:
            with open(sidecar_path(audio_path, kind), encoding='utf-8-sig') as f:
                text = f.read()
        except FileNotFoundError:
            continue
        if not text.strip():
            continue
        return lrc_to_plain(text) if kind == LRC or is_lrc(text) else text
    return ''


def import_folder(
    client,
    root: str,
    read_tags: Callable[[str], object],
    extensions: frozenset[str],
    dry_run: bool = False,
    progress: Callable[[int, int], None] | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> ImportStats:
    """`client` has put(song, lyrics, ref, replace) (ServerClient); with `dry_run` it is
    not called and may be None. `read_tags(path)` returns an object with `artist`,
    `title` and `lyrics`, or None for an unsupported file."""
    stats = ImportStats()
    paths = list(find_audio_files(root, extensions))
    stats.found = len(paths)
    for index, path in enumerate(paths, start=1):
        if should_stop and should_stop():
            stats.cancelled = True
            break
        try:
            _import_one(client, path, read_tags, dry_run, stats)
        except ServerUnavailable as error:
            stats.server_error = str(error)
            break
        if progress:
            progress(index, stats.found)
    return stats


def _import_one(client, path: str, read_tags, dry_run: bool, stats: ImportStats) -> None:
    try:
        tags = read_tags(path)
    except Exception as error:  # any reader failure only skips this file
        _record_error(stats, path, error)
        return
    if tags is None:
        stats.unsupported += 1
        return
    stats.read += 1
    song = song_payload((getattr(tags, 'artist', None), getattr(tags, 'title', None)), (None, None), None)
    if song is None:
        stats.no_name += 1
        return
    lyrics = getattr(tags, 'lyrics', None) or ''
    if lyrics.strip():
        stats.from_tags += 1
    else:
        try:
            lyrics = sidecar_lyrics(path)
        except (OSError, UnicodeDecodeError) as error:
            _record_error(stats, path, error)
            return
        if not lyrics.strip():
            stats.no_lyrics += 1
            return
        stats.from_sidecar += 1
    if dry_run:
        return
    result = str(client.put(song, lyrics, file_ref(path), False).body.get('result', ''))
    if result in ('added', 'same', 'replaced', 'skipped'):
        setattr(stats, result, getattr(stats, result) + 1)
    elif result == 'conflict':
        stats.conflicts += 1
        stats.conflict_files.append(path)


def format_summary(stats: ImportStats, folder: str, dry_run: bool = False) -> str:
    """Multi-line import summary for the command-line script."""
    if stats.cancelled:
        head = 'Import cancelled'
    elif stats.server_error:
        head = 'Import stopped: the lyrics server did not answer'
    else:
        head = 'Dry run finished' if dry_run else 'Import finished'
    lines = [
        f'{head}: {folder}',
        '',
        f'Audio files found: {stats.found}, read: {stats.read}',
        f'{"Would send" if dry_run else "Lyrics sent"}: from tags {stats.from_tags}, from sidecar files {stats.from_sidecar}',
    ]
    if not dry_run:
        lines += [
            f'Server: added {stats.added}, same {stats.same}, updated {stats.replaced}, '
            f'no lyrics after cleaning {stats.skipped}',
            f'Conflicts (the server kept its lyrics): {stats.conflicts}',
        ]
    lines += [
        f'No lyrics in the tags or a sidecar file: {stats.no_lyrics}',
        f'Without artist or title: {stats.no_name}',
        f'Unknown format: {stats.unsupported}, unreadable: {stats.errors}',
    ]
    if stats.server_error:
        lines += ['', f'Server error: {stats.server_error}', 'Start the server and import again; lyrics sent so far are kept.']
    return '\n'.join(lines)


def _record_error(stats: ImportStats, path: str, error: BaseException) -> None:
    stats.errors += 1
    if len(stats.error_samples) < MAX_ERRORS_KEPT:
        stats.error_samples.append((path, f'{type(error).__name__}: {error}'))
