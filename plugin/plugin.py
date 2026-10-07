"""Shironet Lyrics: Picard hooks and actions. A client of the Shironet lyrics server.

The server owns the lyrics cache and fetches from Shironet. The plugin reads tags, asks
the server, and writes the Lyrics tag. Server calls run on a small thread pool and their
answers come back to the GUI thread through a Qt signal: Picard never waits on the server.
(Not Picard's web service: it limits every host it does not know to one request a second.)
"""

from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
import os
import threading

from PyQt6.QtCore import QObject, QStandardPaths, pyqtSignal
from PyQt6.QtWidgets import QFileDialog, QLabel, QLineEdit, QMessageBox, QProgressDialog, QVBoxLayout

from picard.plugin3.api import BaseAction, OptionsPage, PluginApi, Track

from .scan_state import STATE_FILE, ScanState
from .scanner import ScanStats, format_summary, scan_folder
from .server_client import DEFAULT_SERVER_URL, Answer, ServerClient, ServerUnavailable
from .songs import file_ref, raw_lyrics, song_payload
from .tag_reader import AUDIO_EXTENSIONS, read_tags


PLUGIN_NAME = 'Shironet Lyrics'
SERVER_URL_OPTION = 'server_url'
# Emit a progress signal every this many files, so the GUI queue is not flooded.
PROGRESS_STEP = 25
# Parallel requests to the server (it answers from its database, quickly).
WORKERS = 4

_api: PluginApi | None = None
_calls: AsyncCalls | None = None
_state: ScanState | None = None
_scan_job: ScanJob | None = None
# Lyrics on disk before a save, keyed by id(file): a save may rename the file.
_lyrics_before_save: dict[int, str] = {}


def _data_dir() -> str:
    base = QStandardPaths.writableLocation(QStandardPaths.StandardLocation.AppDataLocation)
    return os.path.join(base, 'plugin-data', 'shironet-lyrics')


def _old_cache_path() -> str:
    """The cache file of the plugin before the server; read once to keep the scan state."""
    return os.path.join(_data_dir(), 'lyrics.sqlite3')


def _server_url() -> str:
    return (_api.plugin_config[SERVER_URL_OPTION] or DEFAULT_SERVER_URL).strip()


def _client() -> ServerClient:
    return ServerClient(_server_url())


class AsyncCalls(QObject):
    """Runs blocking server calls on worker threads; callbacks run on the GUI thread."""

    finished = pyqtSignal(object, object)  # callback, Future

    def __init__(self):
        super().__init__()
        self._pool = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix='shironet-lyrics')
        self.finished.connect(self._deliver)

    def submit(self, call, callback) -> None:
        """callback(result, error) runs on the GUI thread; error is None on success."""
        future = self._pool.submit(call)
        future.add_done_callback(lambda done: self.finished.emit(callback, done))

    def _deliver(self, callback, future: Future) -> None:
        try:
            result, error = future.result(), None
        except Exception as exc:  # reported to the callback
            result, error = None, exc
        try:
            callback(result, error)
        except Exception as exc:
            _api.logger.error('Shironet Lyrics: callback failed: %s', exc)

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)


def _song(file) -> dict | None:
    own = (file.orig_metadata.get('artist'), file.orig_metadata.get('title'))
    matched = (file.metadata.get('artist'), file.metadata.get('title'))
    language = file.metadata.get('language') or file.orig_metadata.get('language')
    return song_payload(own, matched, language)


def _record_scanned(file, has_lyrics: bool) -> None:
    """Recorded like the folder scan does, so the scan neither re-reads the file nor
    misses that it has no lyrics."""
    if _state is None:
        return
    try:
        st = os.stat(file.filename)
    except OSError:
        return
    _state.mark_scanned(
        file.filename, st.st_mtime_ns, st.st_size,
        file.orig_metadata.get('artist'), file.orig_metadata.get('title'), has_lyrics,
    )


def _send_file_lyrics(file, replace: bool) -> None:
    """Sends the lyrics on disk to the server (PUT) and records the file as scanned."""
    lyrics = raw_lyrics(file.orig_metadata)
    song = _song(file)
    if not lyrics or not song:
        _record_scanned(file, False)
        return
    ref = file_ref(file.filename)

    def done(answer: Answer | None, error) -> None:
        if error is not None:
            _api.logger.warning('Shironet Lyrics: cannot send the lyrics of %s: %s', file.filename, error)
            return  # not recorded: the next scan sends them
        result = answer.body.get('result')
        if result == 'conflict':
            _api.logger.info('Shironet Lyrics: %s has lyrics that differ from the cached ones; kept the cached ones', file.filename)
        _record_scanned(file, result != 'skipped')

    _calls.submit(lambda: _client().put(song, lyrics, ref, replace), done)


def _on_file_loaded(api: PluginApi, file) -> None:
    _send_file_lyrics(file, replace=False)


def _on_file_pre_save(api: PluginApi, file) -> None:
    _lyrics_before_save[id(file)] = raw_lyrics(file.orig_metadata)


def _on_file_saved(api: PluginApi, file) -> None:
    # Picard sets orig_metadata to the saved metadata before this runs.
    before = _lyrics_before_save.pop(id(file), None)
    # Lyrics changed in this save are a deliberate edit: they win over the cache.
    changed = before is not None and raw_lyrics(file.orig_metadata) != before
    _send_file_lyrics(file, replace=changed)


def _set_lyrics(file, lyrics: str) -> None:
    """Set the lyrics the way an edit in Picard's metadata box does: on the file and its track.

    The track copy keeps the value when Picard merges track metadata into the file again,
    also with "Clear existing tags" on. Nothing is written to disk until the user saves.
    """
    file.metadata['lyrics'] = lyrics
    track = file.parent_item
    if isinstance(track, Track):
        track.metadata['lyrics'] = lyrics
        track.update()
    file.update()


def _on_file_added_to_track(api: PluginApi, track, file) -> None:
    """Fill missing lyrics when a file is matched to a track; the server queues a miss."""
    if raw_lyrics(file.metadata):
        return
    song = _song(file)
    if not song:
        return

    def done(answer: Answer | None, error) -> None:
        if error is not None:
            api.logger.warning('Shironet Lyrics: lyrics server not reachable for %s: %s', file.filename, error)
        elif answer.status == 200 and not raw_lyrics(file.metadata):
            _set_lyrics(file, answer.body['lyrics'])
            api.logger.info('Shironet Lyrics: filled lyrics for %s', file.filename)
        elif answer.status == 202:
            api.logger.info('Shironet Lyrics: %s is %s for Shironet', file.filename, answer.body.get('status'))

    _calls.submit(lambda: _client().fetch(song, 'interactive'), done)


class LookupBatch:
    """Counts the answers of one Lookup Lyrics run and shows the summary after the last."""

    def __init__(self, api: PluginApi, total: int):
        self.api = api
        self.left = total
        self.counts = dict(files=total, filled=0, replaced=0, same=0, queued=0, not_found=0,
                           not_hebrew=0, not_cached=0, no_name=0, unreachable=0)
        self.unreachable_error = None

    def add(self, key: str) -> None:
        self.counts[key] += 1

    def one_done(self) -> None:
        self.left -= 1
        if self.left == 0:
            self.show()

    def show(self) -> None:
        c = self.counts
        lines = [
            f'Files: {c["files"]}',
            f'Filled: {c["filled"]}, replaced different lyrics: {c["replaced"]}, already the cached lyrics: {c["same"]}',
            f'Queued for Shironet now: {c["queued"]}. Run Lookup Lyrics again later to fill them.' if c['queued']
            else 'Queued for Shironet now: 0',
            f'Not found on Shironet (retried later by the server): {c["not_found"]}',
            f'Not Hebrew: {c["not_hebrew"]}; with lyrics but not on the server: {c["not_cached"]}; without artist or title: {c["no_name"]}',
        ]
        if c['unreachable']:
            lines.append(f'\nThe lyrics server did not answer for {c["unreachable"]} files ({_server_url()}): {self.unreachable_error}')
        if c['filled'] or c['replaced']:
            lines.append('\nNothing is written to the files until you save them.')
        summary = '\n'.join(lines)
        self.api.logger.info('Shironet Lyrics: lookup done. %s', summary.replace('\n', ' | '))
        QMessageBox.information(None, PLUGIN_NAME, summary)


class LookupAction(BaseAction):
    """Context menu: fill lyrics from the server; queue misses; replace different lyrics."""

    TITLE = 'Lookup Lyrics'
    MENU = (PLUGIN_NAME,)

    def callback(self, objs):
        files = {}
        for obj in objs:
            for file in obj.iterfiles():
                files[file.filename] = file
        if not files:
            return
        batch = LookupBatch(self.api, len(files))
        for file in files.values():
            song = _song(file)
            if not song:
                batch.add('no_name')
                batch.one_done()
                continue
            current = raw_lyrics(file.metadata)
            if current:
                _calls.submit(lambda song=song: _client().lookup(song),
                              lambda answer, error, file=file, current=current: self._lookup_done(batch, file, current, answer, error))
            else:
                _calls.submit(lambda song=song: _client().fetch(song, 'interactive'),
                              lambda answer, error, file=file: self._fetch_done(batch, file, answer, error))

    @staticmethod
    def _unreachable(batch: LookupBatch, error) -> None:
        batch.add('unreachable')
        batch.unreachable_error = error

    def _lookup_done(self, batch: LookupBatch, file, current: str, answer: Answer | None, error) -> None:
        if error is not None:
            self._unreachable(batch, error)
        elif answer.status == 200:
            if answer.body['lyrics'] == current:
                batch.add('same')
            else:
                _set_lyrics(file, answer.body['lyrics'])
                batch.add('replaced')
        else:
            batch.add('not_cached')
        batch.one_done()

    def _fetch_done(self, batch: LookupBatch, file, answer: Answer | None, error) -> None:
        if error is not None:
            self._unreachable(batch, error)
        elif answer.status == 200:
            _set_lyrics(file, answer.body['lyrics'])
            batch.add('filled')
        elif answer.status == 202:
            batch.add('queued')
        elif answer.body.get('status') in ('not_found', 'failed'):
            batch.add('not_found')
        else:
            batch.add('not_hebrew' if answer.body.get('status') == 'not_hebrew' else 'no_name')
        batch.one_done()


class ScanJob(QObject):
    """Runs scan_folder() on a worker thread with its own scan-state connection."""

    progress = pyqtSignal(int, int)
    finished = pyqtSignal(object)  # ScanStats, or the exception that stopped the scan

    def __init__(self, folder: str, server_url: str):
        super().__init__()
        self.folder = folder
        self.server_url = server_url
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name='shironet-lyrics-scan', daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self, wait: float = 0.0) -> None:
        self._stop.set()
        if wait:
            self._thread.join(wait)

    def _run(self) -> None:
        def report(done: int, total: int) -> None:
            if done % PROGRESS_STEP == 0 or done == total:
                self.progress.emit(done, total)

        try:
            client = ServerClient(self.server_url)
            client.health()  # fail early when the server is down
            state = ScanState(os.path.join(_data_dir(), STATE_FILE))
            try:
                result = scan_folder(state, client, self.folder, read_tags, AUDIO_EXTENSIONS, report, self._stop.is_set)
            finally:
                state.close()
        except Exception as exc:  # reported to the user on the GUI thread
            result = exc
        self.finished.emit(result)


class ScanFolderAction(BaseAction):
    """Tools menu: scan a folder; send its lyrics to the server and queue the songs without."""

    TITLE = 'Scan folder for lyrics...'
    MENU = (PLUGIN_NAME,)

    def callback(self, objs):
        global _scan_job
        api = self.api
        if _scan_job is not None:
            QMessageBox.information(None, PLUGIN_NAME, 'A scan is already running.')
            return
        folder = QFileDialog.getExistingDirectory(None, 'Folder to scan for lyrics', api.plugin_persist['last_scan_folder'])
        if not folder:
            return
        api.plugin_persist['last_scan_folder'] = folder

        dialog = QProgressDialog(f'Scanning {folder}', 'Cancel', 0, 0)
        dialog.setWindowTitle(PLUGIN_NAME)
        dialog.setMinimumDuration(0)
        dialog.setAutoClose(False)
        dialog.setAutoReset(False)

        job = ScanJob(folder, _server_url())
        dialog.canceled.connect(job.stop)

        def on_progress(done: int, total: int) -> None:
            dialog.setMaximum(total)
            dialog.setValue(done)
            dialog.setLabelText(f'Scanning {folder}\n{done} of {total} files')

        def on_finished(result) -> None:
            global _scan_job
            _scan_job = None
            dialog.close()
            _report_scan(api, folder, result)

        job.progress.connect(on_progress)
        job.finished.connect(on_finished)
        _scan_job = job
        api.logger.info('Shironet Lyrics: scanning %s', folder)
        job.start()
        dialog.show()


def _report_scan(api: PluginApi, folder: str, result) -> None:
    if isinstance(result, ServerUnavailable):
        message = f'The lyrics server does not answer at {_server_url()}.\n\n{result}\n\nStart it with "npm start" in the server folder.'
        api.logger.error('Shironet Lyrics: %s', message.replace('\n', ' '))
        QMessageBox.warning(None, PLUGIN_NAME, message)
        return
    if isinstance(result, Exception):
        api.logger.error('Shironet Lyrics: scan of %s failed: %s', folder, result)
        QMessageBox.warning(None, PLUGIN_NAME, f'The scan failed.\n\n{result}')
        return
    stats: ScanStats = result
    for path in stats.conflict_files:
        api.logger.info('Shironet Lyrics: %s has lyrics that differ from the cached ones; kept the cached ones', path)
    for path, message in stats.error_samples:
        api.logger.warning('Shironet Lyrics: cannot read %s: %s', path, message)
    summary = format_summary(stats, folder)
    if stats.conflicts or stats.errors:
        summary += '\nThe log names the files with conflicts or read errors.'
    api.logger.info('Shironet Lyrics: %s', summary.replace('\n\n', ' | ').replace('\n', ', '))
    QMessageBox.information(None, PLUGIN_NAME, summary)


class ShironetOptionsPage(OptionsPage):
    """Options > Plugins > Shironet Lyrics: where the lyrics server runs."""

    NAME = 'shironet_lyrics'
    TITLE = 'Shironet Lyrics'
    PARENT = 'plugins'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel('Lyrics server URL (the server runs with "npm start" in its folder):'))
        self.url_edit = QLineEdit()
        self.url_edit.setPlaceholderText(DEFAULT_SERVER_URL)
        layout.addWidget(self.url_edit)
        layout.addStretch()

    def load(self):
        self.url_edit.setText(self.api.plugin_config[SERVER_URL_OPTION])

    def save(self):
        self.api.plugin_config[SERVER_URL_OPTION] = self.url_edit.text().strip() or DEFAULT_SERVER_URL


def enable(api: PluginApi) -> None:
    global _api, _calls, _state
    _api = api
    api.plugin_config.register_option(SERVER_URL_OPTION, DEFAULT_SERVER_URL)
    api.plugin_persist.register_option('last_scan_folder', '')
    _calls = AsyncCalls()

    os.makedirs(_data_dir(), exist_ok=True)
    try:
        _state = ScanState.open(os.path.join(_data_dir(), STATE_FILE), old_cache=_old_cache_path())
        if _state.copied_from_old_cache:
            api.logger.info('Shironet Lyrics: took over %d scanned files from the old cache', _state.copied_from_old_cache)
    except Exception as exc:  # the plugin works without it; scans then read every file
        api.logger.error('Shironet Lyrics: cannot open the scan state: %s', exc)
        _state = None

    def health_done(answer: Answer | None, error) -> None:
        if error is not None:
            api.logger.warning('Shironet Lyrics: the lyrics server does not answer at %s: %s', _server_url(), error)
        else:
            api.logger.info('Shironet Lyrics: lyrics server %s at %s', answer.body.get('version'), _server_url())

    _calls.submit(lambda: _client().health(), health_done)

    api.register_file_post_load_processor(_on_file_loaded)
    api.register_file_pre_save_processor(_on_file_pre_save)
    api.register_file_post_save_processor(_on_file_saved)
    api.register_file_post_addition_to_track_processor(_on_file_added_to_track)
    api.register_tools_menu_action(ScanFolderAction)
    api.register_options_page(ShironetOptionsPage)
    for register in (
        api.register_file_action,
        api.register_track_action,
        api.register_album_action,
        api.register_cluster_action,
        api.register_clusterlist_action,
    ):
        register(LookupAction)


def disable() -> None:
    global _calls, _state, _scan_job
    if _scan_job is not None:
        _scan_job.stop(wait=5.0)
        _scan_job = None
    _lyrics_before_save.clear()
    if _calls is not None:
        _calls.shutdown()
        _calls = None
    if _state is not None:
        _state.close()
        _state = None
