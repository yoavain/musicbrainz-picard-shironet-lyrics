"""Scan a folder for the Shironet lyrics server, without Picard.

    python scripts/scan_folder.py FOLDER [--server URL]

The same scan as Picard's Tools menu: new and changed files are read; the lyrics they
have go to the server, and the server fetches the songs that have none. Unchanged files
without lyrics are asked for again from what the last scan recorded. The server does the
fetching in the background; this script only reports.

The scan state (which files were read) is shared with the plugin. On its first run it
takes over the scanned files of the old plugin cache, so the first scan stays fast.
Ctrl+C stops after the current file; the work done so far is kept.

Needs mutagen. Without an installed mutagen, it loads the one inside the installed
Picard, which works only when this Python has the same version as Picard's bundled Python.
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
    # Hebrew names in the output: the Windows console default is cp1252.
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

    load_plugin_package()
    from shironet_lyrics.plugin.scan_state import STATE_FILE, ScanState
    from shironet_lyrics.plugin.server_client import DEFAULT_SERVER_URL, ServerClient, ServerUnavailable, Unauthorized

    old_cache = default_db_path()
    parser = argparse.ArgumentParser(description='Scan a folder for the Shironet lyrics server.')
    parser.add_argument('folder', help='folder to scan, including subfolders')
    parser.add_argument('--server', default=DEFAULT_SERVER_URL, help='lyrics server URL (default: %(default)s)')
    parser.add_argument('--state', default=os.path.join(os.path.dirname(old_cache), STATE_FILE),
                        help='scan state file, shared with the plugin (default: %(default)s)')
    parser.add_argument('--picard-exe', default=os.environ.get('PICARD_EXE', DEFAULT_PICARD_EXE),
                        help='Picard executable to load mutagen from (default: %(default)s)')
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
    from shironet_lyrics.plugin.scanner import format_summary, scan_folder
    from shironet_lyrics.plugin.tag_reader import AUDIO_EXTENSIONS, read_tags

    # The token for a server on the network: from the environment, so it stays out of
    # the shell history and the process list.
    client = ServerClient(args.server, token=os.environ.get('LYRICS_SERVER_TOKEN'))
    try:
        version = client.health().body.get('version', '?')
        client.status()  # checks the token
    except Unauthorized:
        print(f'The lyrics server at {args.server} refused the token. Set LYRICS_SERVER_TOKEN.', file=sys.stderr)
        return 1
    except ServerUnavailable as error:
        print(f'The lyrics server does not answer at {args.server}: {error}', file=sys.stderr)
        print('Start it with "npm start" in the server folder.', file=sys.stderr)
        return 1
    print(f'Lyrics server {version} at {args.server}', flush=True)

    os.makedirs(os.path.dirname(os.path.abspath(args.state)), exist_ok=True)
    state = ScanState.open(args.state, old_cache=old_cache)
    if state.copied_from_old_cache:
        print(f'Took over {state.copied_from_old_cache} scanned files from the old plugin cache.')

    stop_requested = []
    signal.signal(signal.SIGINT, lambda signum, frame: stop_requested.append(True))

    def progress(done: int, total: int) -> None:
        if done % PROGRESS_STEP == 0 or done == total:
            print(f'\r{done} of {total} files', end='', file=sys.stderr, flush=True)

    try:
        stats = scan_folder(state, client, folder, read_tags, AUDIO_EXTENSIONS, progress, lambda: bool(stop_requested))
    finally:
        state.close()
    print(file=sys.stderr)
    print(format_summary(stats, folder))
    for path in stats.conflict_files[:MAX_PATHS_LISTED]:
        print(f'Conflict (the server kept its lyrics): {path}')
    for path, message in stats.error_samples[:MAX_PATHS_LISTED]:
        print(f'Unreadable: {path}: {message}')
    return 1 if stats.server_error else 0


if __name__ == '__main__':
    sys.exit(main())
