"""Scan a folder into the Shironet Lyrics cache without opening Picard.

    python scripts/scan_folder.py FOLDER [--db PATH] [--picard-exe PATH]

Uses the same cache file as the plugin by default, and the same scan: only new
and changed files are read, and only Hebrew songs are stored. It is safe to run
while Picard is open. Press Ctrl+C to stop; the work done so far is kept.

Needs mutagen. Without an installed mutagen, it loads the one inside the
installed Picard, which works only when this Python has the same version as
Picard's bundled Python.
"""

from __future__ import annotations

import argparse
import os
import signal
import sys

from _bootstrap import DEFAULT_PICARD_EXE, default_db_path, load_mutagen, load_plugin_package

# Print a progress line every this many files.
PROGRESS_STEP = 100
# Conflict and error paths listed after the summary; the rest are only counted.
MAX_PATHS_LISTED = 20


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Scan a folder into the Shironet Lyrics cache.')
    parser.add_argument('folder', help='folder to scan, including subfolders')
    parser.add_argument('--db', default=default_db_path(), help='cache file (default: %(default)s)')
    parser.add_argument(
        '--picard-exe',
        default=os.environ.get('PICARD_EXE', DEFAULT_PICARD_EXE),
        help='Picard executable to load mutagen from (default: %(default)s)',
    )
    args = parser.parse_args(argv)

    folder = os.path.abspath(args.folder)
    if not os.path.isdir(folder):
        parser.error(f'not a folder: {folder}')
    if not load_mutagen(args.picard_exe):
        print(
            f'mutagen not found. Install it, or run this script with the same Python version as '
            f'Picard (Python {sys.version_info.major}.{sys.version_info.minor} could not load it '
            f'from {args.picard_exe}).',
            file=sys.stderr,
        )
        return 2

    load_plugin_package()
    from shironet_lyrics.src.lyrics_cache import LyricsCache
    from shironet_lyrics.src.scanner import format_summary, scan_folder
    from shironet_lyrics.src.tag_reader import AUDIO_EXTENSIONS, read_tags

    os.makedirs(os.path.dirname(os.path.abspath(args.db)), exist_ok=True)
    cache = LyricsCache(args.db)
    if cache.cleanup_counts:
        updated, removed = cache.cleanup_counts
        print(f'Cleaned stored lyrics (prefixes, credit headers, placeholders): {updated} updated, {removed} removed')
    print(f'Cache: {args.db} ({cache.count()} songs)', flush=True)

    stop_requested = []
    signal.signal(signal.SIGINT, lambda signum, frame: stop_requested.append(True))

    def progress(done: int, total: int) -> None:
        if done % PROGRESS_STEP == 0 or done == total:
            print(f'\r{done} of {total} files', end='', file=sys.stderr, flush=True)

    try:
        stats = scan_folder(
            cache, folder, read_tags, AUDIO_EXTENSIONS, progress, lambda: bool(stop_requested)
        )
        print(file=sys.stderr)
        print(format_summary(stats, folder, cache.count()))
    finally:
        cache.close()

    for path in stats.conflict_files[:MAX_PATHS_LISTED]:
        print(f'Conflict (kept cached lyrics): {path}')
    for path, message in stats.error_samples[:MAX_PATHS_LISTED]:
        print(f'Unreadable: {path}: {message}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
