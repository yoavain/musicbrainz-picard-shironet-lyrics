"""Import the lyrics a folder's audio files already have into the lyrics server.

    python scripts/import_lyrics.py FOLDER [--server URL] [--dry-run] [--verbose]

The reverse of export_lyrics.py. For every audio file under FOLDER (subfolders included):
- The lyrics come from the tags, else from a .txt or .lrc sidecar with the same name
  (a .lrc loses its time tags: the cache keeps plain text).
- They go to the server under the file's artist and title. The server keeps its own
  lyrics when they differ (a conflict, listed after the summary).

Any language: the cache answers Hebrew and English songs alike, and a cached song fills
every version of it ("Live", "Remastered" ...). Nothing is queued for Shironet; that is
the folder scan's job (scan_folder.py). Every file is read on every run; a second run
answers "same" for everything sent before. Ctrl+C stops after the current file.

Needs mutagen, like scan_folder.py. For a server on the network, set LYRICS_SERVER_TOKEN.
"""

from __future__ import annotations

import argparse
import os
import signal
import sys

from _bootstrap import DEFAULT_PICARD_EXE, load_mutagen, load_plugin_package

PROGRESS_STEP = 100
# Conflict and error paths listed without --verbose.
MAX_LISTED = 20


def main(argv: list[str] | None = None) -> int:
    # Hebrew names in the output: the Windows console default is cp1252.
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

    load_plugin_package()
    from shironet_lyrics.plugin.server_client import DEFAULT_SERVER_URL, ServerClient, ServerUnavailable, Unauthorized

    parser = argparse.ArgumentParser(description='Import the lyrics of audio files and their sidecars into the lyrics server.')
    parser.add_argument('folder', help='folder to import, including subfolders')
    parser.add_argument('--server', default=DEFAULT_SERVER_URL, help='lyrics server URL (default: %(default)s)')
    parser.add_argument('--dry-run', action='store_true', help='read and count only; send nothing')
    parser.add_argument('--verbose', action='store_true', help=f'list every conflict (default: the first {MAX_LISTED})')
    parser.add_argument('--picard-exe', default=os.environ.get('PICARD_EXE', DEFAULT_PICARD_EXE),
                        help='Picard executable to load mutagen from (default: %(default)s)')
    args = parser.parse_args(argv)

    folder = os.path.abspath(args.folder)
    if not os.path.isdir(folder):
        parser.error(f'not a folder: {folder}')
    if not load_mutagen(args.picard_exe):
        print('mutagen not found; see scan_folder.py --help', file=sys.stderr)
        return 2
    from shironet_lyrics.plugin.lyrics_import import format_summary, import_folder
    from shironet_lyrics.plugin.tag_reader import AUDIO_EXTENSIONS, read_tags

    client = None
    if not args.dry_run:
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

    stop_requested = []
    signal.signal(signal.SIGINT, lambda signum, frame: stop_requested.append(True))

    def progress(done: int, total: int) -> None:
        if done % PROGRESS_STEP == 0 or done == total:
            print(f'\r{done} of {total} files', end='', file=sys.stderr, flush=True)

    stats = import_folder(client, folder, read_tags, AUDIO_EXTENSIONS, args.dry_run, progress, lambda: bool(stop_requested))
    print(file=sys.stderr)
    print(format_summary(stats, folder, args.dry_run))
    for path in stats.conflict_files if args.verbose else stats.conflict_files[:MAX_LISTED]:
        print(f'Conflict (the server kept its lyrics): {path}')
    if not args.verbose and len(stats.conflict_files) > MAX_LISTED:
        print(f'... and {len(stats.conflict_files) - MAX_LISTED} more conflicts (--verbose lists all)')
    for path, message in stats.error_samples:
        print(f'Unreadable: {path}: {message}')
    return 1 if stats.server_error else 0


if __name__ == '__main__':
    sys.exit(main())
