"""Fetch queued songs from Shironet at a slow, self-adjusting pace.

    python scripts/shironet_worker.py enqueue-missing FOLDER
    python scripts/shironet_worker.py enqueue-calibration 20
    python scripts/shironet_worker.py enqueue ARTIST TITLE
    python scripts/shironet_worker.py run [--max-requests N] [--hours H] [--notify] ...
    python scripts/shironet_worker.py status [--all-misses]
    python scripts/shironet_worker.py requeue-not-found

Picard also queues the Hebrew songs it cannot find in the cache. The queue, the request log and the learned pace live in the plugin's cache file
(--db picks another). Fetched lyrics go into the cache, where Picard finds them.
Calibration songs are already cached: their fetched lyrics are only compared.

Ctrl+C stops a run after the current request. enqueue-missing needs mutagen, like
scan_folder.py; the other commands need only the standard library.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import os
import signal
import subprocess
import sys
import time
import urllib.request

from _bootstrap import DEFAULT_PICARD_EXE, default_db_path, load_mutagen, load_plugin_package

load_plugin_package()

from shironet_lyrics.src.lyrics_cache import (  # noqa: E402
    DEFAULT_MISS_TTL_HOURS,
    SOURCE_EMBEDDED,
    LyricsCache,
    is_hebrew_song,
)
from shironet_lyrics.src import shironet_queue as queue  # noqa: E402
from shironet_lyrics.src.shironet_worker import (  # noqa: E402
    PaceLimits,
    Pacer,
    PaceState,
    ShironetClient,
    load_pace,
    pace_report,
    run,
    save_pace,
)


# Songs not found that status lists without --all-misses.
MISSES_SHOWN = 30


def say(message: str) -> None:
    print(f'{time.strftime("%H:%M:%S")} {message}', flush=True)


class Notifier:
    """Windows notification and/or ntfy push. Messages are plain ASCII on purpose."""

    def __init__(self, windows: bool, ntfy_url: str | None):
        self.windows = windows and sys.platform == 'win32'
        self.ntfy_url = ntfy_url

    def __call__(self, title: str, message: str) -> None:
        if self.windows:
            script = (
                'Add-Type -AssemblyName System.Windows.Forms; '
                '$n = New-Object System.Windows.Forms.NotifyIcon; '
                '$n.Icon = [System.Drawing.SystemIcons]::Information; '
                '$n.BalloonTipTitle = $env:SL_TITLE; $n.BalloonTipText = $env:SL_MESSAGE; '
                '$n.Visible = $true; $n.ShowBalloonTip(10000); Start-Sleep -Seconds 10; $n.Dispose()'
            )
            env = dict(os.environ, SL_TITLE=title, SL_MESSAGE=message)
            try:
                subprocess.Popen(
                    ['powershell', '-NoProfile', '-WindowStyle', 'Hidden', '-Command', script],
                    env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
            except OSError as exc:
                say(f'Windows notification failed: {exc}')
        if self.ntfy_url:
            request = urllib.request.Request(
                self.ntfy_url, data=message.encode('utf-8'), headers={'Title': title}, method='POST'
            )
            try:
                urllib.request.urlopen(request, timeout=10).close()
            except OSError as exc:
                say(f'ntfy notification failed: {exc}')


# --- commands -------------------------------------------------------------------

def cmd_enqueue(cache: LyricsCache, args) -> int:
    added = queue.enqueue(cache, args.artist, args.title)
    print('queued' if added else 'not queued (already queued, already cached, or empty name)')
    return 0


def cmd_enqueue_missing(cache: LyricsCache, args) -> int:
    if not load_mutagen(args.picard_exe):
        print('mutagen not found; see scan_folder.py --help', file=sys.stderr)
        return 2
    from shironet_lyrics.src.scanner import find_audio_files
    from shironet_lyrics.src.tag_reader import AUDIO_EXTENSIONS, read_tags

    folder = os.path.abspath(args.folder)
    paths = list(find_audio_files(folder, AUDIO_EXTENSIONS))
    without_lyrics = not_hebrew = added = errors = 0
    with cache.batch():
        for index, path in enumerate(paths, start=1):
            try:
                tags = read_tags(path)
            except Exception:  # unreadable files are scan_folder.py's business
                errors += 1
                continue
            if tags is None or tags.lyrics:
                continue
            without_lyrics += 1
            if not is_hebrew_song(tags.artist, tags.title):
                not_hebrew += 1
            elif queue.enqueue(cache, tags.artist, tags.title):
                added += 1
            if index % 200 == 0:
                print(f'\r{index} of {len(paths)} files', end='', file=sys.stderr, flush=True)
    print(file=sys.stderr)
    print(f'Audio files: {len(paths)}, without lyrics: {without_lyrics}, not Hebrew: {not_hebrew}, '
          f'unreadable: {errors}')
    print(f'Queued for Shironet: {added} (the rest are cached or already queued)')
    return 0


def cmd_enqueue_calibration(cache: LyricsCache, args) -> int:
    rows = cache.connection.execute(
        'SELECT artist, title FROM lyrics WHERE source = ? ORDER BY RANDOM() LIMIT ?',
        (SOURCE_EMBEDDED, args.count),
    ).fetchall()
    added = sum(queue.enqueue(cache, artist, title, queue.PURPOSE_CALIBRATE) for artist, title in rows)
    print(f'Queued {added} cached songs for calibration ({len(rows) - added} were already queued).')
    return 0


def cmd_run(cache: LyricsCache, args) -> int:
    limits = PaceLimits(min_interval=args.min_interval, base_cooldown=args.cooldown * 60)
    state = PaceState(interval=args.interval or 120.0, cooldown=limits.base_cooldown)
    if not args.reset_pace:
        state = load_pace(cache, state)
        if args.interval:
            state.interval = args.interval
    pacer = Pacer(state, limits)
    save_pace(cache, state)

    cookie_path = None if args.no_cookies else os.path.join(os.path.dirname(args.db), 'shironet-cookies.txt')
    client = ShironetClient(cookie_path)
    notify = Notifier(args.notify, args.ntfy_url)

    stop = []
    signal.signal(signal.SIGINT, lambda signum, frame: stop.append(True))

    def sleep(seconds: float) -> None:
        end = time.time() + seconds
        while not stop and time.time() < end:
            time.sleep(min(1.0, end - time.time()))

    def on_challenge(wait: float) -> None:
        notify(
            'Shironet CAPTCHA',
            f'Shironet asked for a CAPTCHA. The worker waits {wait / 60:.0f} min. '
            'To test clearing it, solve it at https://shironet.mako.co.il in your browser.',
        )

    say(f'{queue.due_count(cache)} songs to fetch. First wait {state.interval:.0f} s between requests. '
        'Ctrl+C stops.')
    stats = run(
        cache, client, pacer,
        sleep=sleep,
        max_requests=args.max_requests,
        max_seconds=args.hours * 3600 if args.hours else None,
        stop_on_challenge=args.stop_on_challenge,
        should_stop=lambda: bool(stop),
        say=say,
        on_challenge=on_challenge,
        miss_ttl_hours=args.miss_ttl_hours,
    )
    minutes = (time.time() - stats.started) / 60
    summary = (
        f'Stopped: {stats.stopped_because}. {stats.requests} requests in {minutes:.0f} min. '
        f'Done {stats.done}, not found {stats.not_found}, CAPTCHAs {stats.challenges}, errors {stats.errors}. '
        f'Pace now {pacer.state.interval:.0f} s.'
    )
    say(summary)
    notify('Shironet worker finished', summary)
    return 0


def _local_time(stored: str) -> str:
    try:
        return datetime.fromisoformat(stored).astimezone().strftime('%Y-%m-%d %H:%M')
    except ValueError:
        return stored


def cmd_requeue_not_found(cache: LyricsCache, args) -> int:
    print(f'{queue.requeue(cache)} songs set back to pending.')
    return 0


def cmd_status(cache: LyricsCache, args) -> int:
    print('Queue:')
    counts = queue.counts(cache)
    if not counts:
        print('  empty')
    for (purpose, status), count in sorted(counts.items()):
        print(f'  {purpose:<10} {status:<10} {count}')
    if counts:
        print(f'  due now (pending, or past their retry time): {queue.due_count(cache)}')

    state = load_pace(cache, PaceState())
    print(f'Pace: {state.interval:.0f} s between requests, next cooldown {state.cooldown / 60:.0f} min, '
          f'{state.streak} successes in a row{" (after a CAPTCHA)" if state.challenged else ""}')

    report = pace_report(queue.request_log(cache))
    print(f'Requests: {report.requests} (ok {report.ok}, CAPTCHA {report.challenges}, error {report.errors})')
    for number, (ok, gap) in enumerate(report.stretches, start=1):
        gap_text = 'n/a' if gap is None else f'{gap:.0f} s'
        print(f'  stretch {number}: {ok} ok requests, median gap {gap_text}')
    for wait in report.recoveries:
        print(f'  unblocked {wait / 60:.0f} min after a CAPTCHA')

    missed = queue.misses(cache)
    if missed:
        shown = missed if args.all_misses else missed[:MISSES_SHOWN]
        print(f'Not found on Shironet: {len(missed)} songs. Fix the title in the tags if it is spelled '
              f'differently on Shironet, then run enqueue-missing again.')
        for artist, title, alt_artist, alt_title, result, retry_after in shown:
            alternate = f'  (also tried: {alt_artist} - {alt_title})' if alt_title else ''
            retry = f'; retry after {_local_time(retry_after)}' if retry_after else ''
            print(f'  {artist} - {title}{alternate}  [{result}{retry}]')
        if len(shown) < len(missed):
            print(f'  ... {len(missed) - len(shown)} more; status --all-misses lists all of them')

    calibration = queue.results(cache, queue.PURPOSE_CALIBRATE)
    if calibration:
        scores = [float(result.split()[1]) for _, _, status, result in calibration
                  if status == queue.DONE and result and result.startswith('similarity')]
        missing = [(artist, title, result) for artist, title, status, result in calibration
                   if status == queue.NOT_FOUND]
        print(f'Calibration: {len(scores)} fetched, {len(missing)} not found, '
              f'{sum(1 for s in scores if s >= 0.9)} with similarity >= 0.90'
              + (f', average {sum(scores) / len(scores):.2f}' if scores else ''))
        for artist, title, result in missing[:10]:
            print(f'  not found: {artist} - {title} ({result})')
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Fetch queued songs from Shironet at a slow pace.')
    parser.add_argument('--db', default=default_db_path(), help='cache file (default: %(default)s)')
    commands = parser.add_subparsers(dest='command', required=True)

    one = commands.add_parser('enqueue', help='queue one song')
    one.add_argument('artist')
    one.add_argument('title')
    one.set_defaults(handler=cmd_enqueue)

    missing = commands.add_parser('enqueue-missing', help='queue Hebrew songs in FOLDER whose files have no lyrics')
    missing.add_argument('folder')
    missing.add_argument('--picard-exe', default=os.environ.get('PICARD_EXE', DEFAULT_PICARD_EXE))
    missing.set_defaults(handler=cmd_enqueue_missing)

    calibrate = commands.add_parser('enqueue-calibration', help='queue N random cached songs to compare')
    calibrate.add_argument('count', type=int)
    calibrate.set_defaults(handler=cmd_enqueue_calibration)

    runner = commands.add_parser('run', help='fetch pending songs')
    runner.add_argument('--interval', type=float, help='seconds between requests (default: the learned pace, else 120)')
    runner.add_argument('--min-interval', type=float, default=20.0, help='the pace never goes below this (default: 20)')
    runner.add_argument('--cooldown', type=float, default=30.0, help='minutes to wait after a first CAPTCHA (default: 30)')
    runner.add_argument('--max-requests', type=int, help='stop after this many requests')
    runner.add_argument('--hours', type=float, help='stop after this many hours')
    runner.add_argument('--stop-on-challenge', action='store_true', help='stop at the first CAPTCHA instead of waiting')
    runner.add_argument('--reset-pace', action='store_true', help='forget the learned pace')
    runner.add_argument('--no-cookies', action='store_true', help='do not keep cookies between requests')
    runner.add_argument('--notify', action='store_true', help='Windows notification on a CAPTCHA and at the end')
    runner.add_argument('--ntfy-url', help='also push those notifications to this ntfy topic URL')
    runner.add_argument('--miss-ttl-hours', type=float, default=DEFAULT_MISS_TTL_HOURS,
                        help='hours before a song not found is searched again (default: %(default)s)')
    runner.set_defaults(handler=cmd_run)

    status = commands.add_parser('status', help='queue, pace, songs not found, calibration summary')
    status.add_argument('--all-misses', action='store_true', help='list every song not found')
    status.set_defaults(handler=cmd_status)

    requeue = commands.add_parser('requeue-not-found', help='set songs not found back to pending')
    requeue.set_defaults(handler=cmd_requeue_not_found)

    args = parser.parse_args(argv)
    args.db = os.path.abspath(args.db)
    os.makedirs(os.path.dirname(args.db), exist_ok=True)
    cache = LyricsCache(args.db)
    try:
        return args.handler(cache, args)
    finally:
        cache.close()


if __name__ == '__main__':
    sys.exit(main())
