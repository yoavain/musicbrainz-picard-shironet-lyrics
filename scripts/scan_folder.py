"""Fill the Shironet Lyrics cache from a folder, then fetch the rest from Shironet.

    python scripts/scan_folder.py FOLDER [--no-fetch] [--notify] [--hours H] ...

A batch run in two steps:
1. Scan, the same as Picard's Tools menu scan: only new and changed files are read,
   their Hebrew lyrics are stored, and Hebrew songs without lyrics are queued.
2. Unless --no-fetch, run the Shironet worker (shironet_worker.py run) until no
   queued song is due. Afterwards every queued song is cached, or marked "not
   found" and left alone until its retry time (a week by default).

Uses the same cache file as the plugin by default. It is safe to run while Picard
is open. Ctrl+C stops either step; the work done so far is kept.

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
    fetch = parser.add_argument_group('fetching from Shironet (passed to shironet_worker.py run)')
    fetch.add_argument('--no-fetch', action='store_true', help='only scan and queue; do not fetch')
    fetch.add_argument('--hours', type=float, help='stop fetching after this many hours')
    fetch.add_argument('--max-requests', type=int, help='stop fetching after this many requests')
    fetch.add_argument('--stop-on-challenge', action='store_true', help='stop at the first CAPTCHA')
    fetch.add_argument('--miss-ttl-hours', type=float, help='hours before a miss is searched again')
    fetch.add_argument('--notify', action='store_true', help='Windows notification on a CAPTCHA and at the end')
    fetch.add_argument('--ntfy-url', help='also push those notifications to this ntfy topic URL')
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
    import shironet_worker
    from shironet_lyrics.src import shironet_queue as queue
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
        due = queue.due_count(cache)
    finally:
        cache.close()

    for path in stats.conflict_files[:MAX_PATHS_LISTED]:
        print(f'Conflict (kept cached lyrics): {path}')
    for path, message in stats.error_samples[:MAX_PATHS_LISTED]:
        print(f'Unreadable: {path}: {message}')

    if args.no_fetch or stats.cancelled:
        if due:
            print(f'{due} queued songs are due. Run scripts/shironet_worker.py run to fetch them.')
        return 0
    if not due:
        print('No queued song is due for Shironet.')
        return 0
    print(f'\nFetching {due} queued songs from Shironet.', flush=True)
    return shironet_worker.main(['--db', args.db, 'run', *_worker_options(args)])


def _worker_options(args) -> list[str]:
    options = []
    for name in ('hours', 'max_requests', 'miss_ttl_hours', 'ntfy_url'):
        value = getattr(args, name)
        if value is not None:
            options += ['--' + name.replace('_', '-'), str(value)]
    for name in ('stop_on_challenge', 'notify'):
        if getattr(args, name):
            options.append('--' + name.replace('_', '-'))
    return options


if __name__ == '__main__':
    sys.exit(main())
