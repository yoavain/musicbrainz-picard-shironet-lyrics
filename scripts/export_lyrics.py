"""Export embedded lyrics to sidecar files next to the audio files, for Plex.

    python scripts/export_lyrics.py FOLDER [--dry-run] [--overwrite] [--clean] [--verbose]

Plex does not read embedded lyrics; it reads a .lrc (timed) or .txt (plain) file with
the same name as the track, in the same folder, in UTF-8:
https://support.plex.tv/articles/215916117-adding-local-lyrics/

For every audio file under FOLDER (subfolders included):
- A file that already has a .lrc or .txt sidecar is skipped without reading its tags,
  unless --overwrite.
- Synced lyrics (ID3 SYLT) become a .lrc. Plain lyrics whose lines carry LRC time tags
  ([01:23.45]) become a .lrc too. Other lyrics become a .txt.
- The text is the tag's text, with LF newlines and without a "heb||"-style prefix.
  --clean also removes a title-and-credits header and skips "instrumental" placeholders.

Any language. This script reads tags and writes sidecar files only: it does not use
or change the lyrics cache. It needs mutagen, like scan_folder.py.
"""

from __future__ import annotations

import argparse
from collections import Counter
import os
import signal
import sys

from _bootstrap import DEFAULT_PICARD_EXE, load_mutagen, load_plugin_package

PROGRESS_STEP = 100
# Written files and errors listed without --verbose.
MAX_LISTED = 20


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Export embedded lyrics to .lrc/.txt sidecar files.')
    parser.add_argument('folder', help='folder to process, including subfolders')
    parser.add_argument('--dry-run', action='store_true', help='report what would be written; write nothing')
    parser.add_argument('--overwrite', action='store_true', help='re-export files that already have a sidecar')
    parser.add_argument('--clean', action='store_true',
                        help='remove title-and-credits headers; skip "instrumental" placeholders')
    parser.add_argument('--verbose', action='store_true', help='list every file written')
    parser.add_argument('--picard-exe', default=os.environ.get('PICARD_EXE', DEFAULT_PICARD_EXE),
                        help='Picard executable to load mutagen from (default: %(default)s)')
    args = parser.parse_args(argv)

    folder = os.path.abspath(args.folder)
    if not os.path.isdir(folder):
        parser.error(f'not a folder: {folder}')
    if not load_mutagen(args.picard_exe):
        print('mutagen not found; see scan_folder.py --help', file=sys.stderr)
        return 2
    load_plugin_package()
    from shironet_lyrics.plugin.lyrics_export import LRC, TXT, Outcome, export_file
    from shironet_lyrics.plugin.scanner import find_audio_files
    from shironet_lyrics.plugin.tag_reader import AUDIO_EXTENSIONS

    stop = []
    signal.signal(signal.SIGINT, lambda signum, frame: stop.append(True))

    paths = list(find_audio_files(folder, AUDIO_EXTENSIONS))
    outcomes = Counter()
    kinds = Counter()
    written, errors = [], []
    for index, path in enumerate(paths, start=1):
        if stop:
            break
        try:
            outcome, target, lyrics = export_file(path, args.overwrite, args.clean, args.dry_run)
        except Exception as exc:  # an unreadable file only skips that file
            errors.append((path, f'{type(exc).__name__}: {exc}'))
            continue
        outcomes[outcome] += 1
        if outcome is Outcome.WRITTEN:
            kinds[lyrics.kind] += 1
            written.append((target, lyrics.source))
        if index % PROGRESS_STEP == 0 or index == len(paths):
            print(f'\r{index} of {len(paths)} files', end='', file=sys.stderr, flush=True)
    print(file=sys.stderr)

    verb = 'Would write' if args.dry_run else 'Wrote'
    for target, source in written if args.verbose else written[:MAX_LISTED]:
        print(f'{verb} {target}  (from {source})')
    if not args.verbose and len(written) > MAX_LISTED:
        print(f'... and {len(written) - MAX_LISTED} more (--verbose lists all)')
    for path, message in errors[:MAX_LISTED]:
        print(f'Unreadable: {path}: {message}')

    print(f'\n{"Stopped" if stop else "Done"}: {folder}')
    print(f'Audio files: {len(paths)}')
    print(f'{verb}: {outcomes[Outcome.WRITTEN]} ({kinds[LRC]} .lrc, {kinds[TXT]} .txt)')
    print(f'Skipped, sidecar already there: {outcomes[Outcome.EXISTS]}')
    if args.overwrite:
        print(f'Unchanged (same text): {outcomes[Outcome.UNCHANGED]}')
    print(f'No lyrics in the tags: {outcomes[Outcome.NO_LYRICS]}')
    print(f'Unknown format: {outcomes[Outcome.UNSUPPORTED]}, unreadable: {len(errors)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
