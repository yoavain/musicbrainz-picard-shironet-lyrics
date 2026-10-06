"""Shironet Lyrics: Picard hooks, the cache lookup, and the folder scan job."""

from __future__ import annotations

import os
import sqlite3
import threading

from PyQt6.QtCore import QObject, QStandardPaths, pyqtSignal
from PyQt6.QtWidgets import QFileDialog, QMessageBox, QProgressDialog

from picard.plugin3.api import BaseAction, PluginApi, Track

from .lyrics_cache import Entry, LyricsCache, PutResult, embedded_lyrics, is_hebrew_song
from .scanner import ScanStats, format_summary, scan_folder
from . import shironet_queue as queue
from .tag_reader import AUDIO_EXTENSIONS, read_tags


PLUGIN_NAME = 'Shironet Lyrics'

# Emit a progress signal every this many files, so the GUI queue is not flooded.
PROGRESS_STEP = 25

_api: PluginApi | None = None
_cache: LyricsCache | None = None
_scan_job: ScanJob | None = None
# Lyrics on disk before a save, keyed by id(file): a save may rename the file.
_lyrics_before_save: dict[int, str] = {}


def _db_path() -> str:
    base = QStandardPaths.writableLocation(QStandardPaths.StandardLocation.AppDataLocation)
    return os.path.join(base, 'plugin-data', 'shironet-lyrics', 'lyrics.sqlite3')


def _names(file) -> list[tuple[str, str]]:
    """Artist and title from the file's own tags, then from the matched track."""
    return [
        (metadata.get('artist'), metadata.get('title'))
        for metadata in (file.orig_metadata, file.metadata)
    ]


def _is_hebrew_file(file, lyrics: str) -> bool:
    names = [name for pair in _names(file) for name in pair]
    language = file.metadata.get('language') or file.orig_metadata.get('language')
    return is_hebrew_song(*names, lyrics=lyrics, language=language)


def _store_file(file, replace: bool = False) -> None:
    """Store the lyrics on disk for one Hebrew song and mark the file as scanned."""
    try:
        st = os.stat(file.filename)
    except OSError:
        return
    lyrics = embedded_lyrics(file.orig_metadata)
    try:
        with _cache.batch():
            if lyrics and _is_hebrew_file(file, lyrics):
                results = _cache.put_file_lyrics(_names(file), lyrics, file.filename, replace)
                if PutResult.CONFLICT in results:
                    _api.logger.info(
                        'Lyrics cache: %s has lyrics that differ from the cached ones; kept the cached ones',
                        file.filename,
                    )
            # Recorded like the folder scan does, so the scan neither re-reads this file
            # nor misses that it has no lyrics.
            _cache.mark_scanned(
                file.filename, st.st_mtime_ns, st.st_size,
                file.orig_metadata.get('artist'), file.orig_metadata.get('title'), bool(lyrics),
            )
    except sqlite3.Error as exc:
        _api.logger.error('Lyrics cache: cannot store lyrics from %s: %s', file.filename, exc)


def _on_file_loaded(api: PluginApi, file) -> None:
    if _cache is not None:
        _store_file(file)


def _on_file_pre_save(api: PluginApi, file) -> None:
    if _cache is not None:
        _lyrics_before_save[id(file)] = embedded_lyrics(file.orig_metadata)


def _on_file_saved(api: PluginApi, file) -> None:
    # Picard sets orig_metadata to the saved metadata before this runs.
    before = _lyrics_before_save.pop(id(file), None)
    if _cache is None:
        return
    # Lyrics changed in this save are a deliberate edit: they win over the cache.
    changed = before is not None and embedded_lyrics(file.orig_metadata) != before
    _store_file(file, replace=changed)


def _lookup(file) -> Entry | None:
    """Cached lyrics for a file: matched artist and title first, then the file's own tags.

    No Hebrew check here: the cache holds only Hebrew songs, so other songs miss anyway,
    and Hebrew songs with transliterated tags still hit.
    """
    return _cache.lookup([
        (file.metadata.get('artist'), file.metadata.get('title')),
        (file.orig_metadata.get('artist'), file.orig_metadata.get('title')),
    ])


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


def _queue_for_shironet(file) -> bool:
    """Queue a Hebrew song that missed the cache, for scripts/shironet_worker.py.

    The file's own artist and title are the primary name: they are what the user
    edits when a title is spelled differently on Shironet. The matched MusicBrainz
    name, when it differs, is a second exact name to try.
    """
    own = (file.orig_metadata.get('artist'), file.orig_metadata.get('title'))
    matched = (file.metadata.get('artist'), file.metadata.get('title'))
    language = file.metadata.get('language') or file.orig_metadata.get('language')
    if not is_hebrew_song(*own, *matched, language=language):
        return False
    if all(own):
        return queue.enqueue(_cache, *own, alternate=matched)
    return queue.enqueue(_cache, *matched)


def _on_file_added_to_track(api: PluginApi, track, file) -> None:
    """Fill missing lyrics from the cache when a file is matched to a track; queue a miss."""
    if _cache is None or embedded_lyrics(file.metadata):
        return
    try:
        entry = _lookup(file)
        queued = entry is None and _queue_for_shironet(file)
    except sqlite3.Error as exc:
        api.logger.error('Lyrics cache: lookup failed for %s: %s', file.filename, exc)
        return
    if entry is not None:
        _set_lyrics(file, entry.lyrics)
        api.logger.info(
            'Lyrics cache: filled lyrics for %s from "%s - %s"', file.filename, entry.artist, entry.title
        )
    elif queued:
        api.logger.info('Lyrics cache: %s is not cached; queued for Shironet', file.filename)


class LookupAction(BaseAction):
    """Context menu: set cached lyrics on the selected files, replacing different ones."""

    TITLE = 'Lookup Lyrics'
    MENU = (PLUGIN_NAME,)

    def callback(self, objs):
        api = self.api
        if _cache is None:
            QMessageBox.warning(None, PLUGIN_NAME, 'The lyrics cache is not open. See the log.')
            return

        files = {}
        for obj in objs:
            for file in obj.iterfiles():
                files[file.filename] = file

        filled = replaced = same = queued = 0
        not_found = []
        try:
            for file in files.values():
                entry = _lookup(file)
                if entry is None:
                    not_found.append(file)
                    queued += _queue_for_shironet(file)
                    continue
                current = embedded_lyrics(file.metadata)
                if current == entry.lyrics:
                    same += 1
                    continue
                _set_lyrics(file, entry.lyrics)
                if current:
                    replaced += 1
                else:
                    filled += 1
        except sqlite3.Error as exc:
            api.logger.error('Lyrics cache: lookup failed: %s', exc)
            QMessageBox.warning(None, PLUGIN_NAME, f'The lookup failed.\n\n{exc}')
            return

        for file in not_found:
            api.logger.info(
                'Lyrics cache: no cached lyrics for %s ("%s - %s")',
                file.filename, file.metadata.get('artist'), file.metadata.get('title'),
            )
        summary = (
            f'Files: {len(files)}\n'
            f'Filled: {filled}, replaced different lyrics: {replaced}\n'
            f'Already the cached lyrics: {same}\n'
            f'Not in the cache: {len(not_found)}, newly queued for Shironet: {queued}'
        )
        if queued:
            summary += '\nRun scripts/shironet_worker.py run to fetch the queued songs.'
        if filled or replaced:
            summary += '\n\nNothing is written to the files until you save them.'
        if not_found:
            summary += '\nThe log names the files that are not in the cache.'
        api.logger.info('Lyrics cache: lookup done. %s', summary.split('\n\n')[0].replace('\n', ', '))
        QMessageBox.information(None, PLUGIN_NAME, summary)


class ScanJob(QObject):
    """Runs scan_folder() on a worker thread with its own DB connection."""

    progress = pyqtSignal(int, int)
    finished = pyqtSignal(object)  # ScanStats, or the exception that stopped the scan

    def __init__(self, folder: str):
        super().__init__()
        self.folder = folder
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name='lyrics-cache-scan', daemon=True)

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
            cache = LyricsCache(_db_path())
            try:
                result = scan_folder(
                    cache, self.folder, read_tags, AUDIO_EXTENSIONS, report, self._stop.is_set
                )
            finally:
                cache.close()
        except Exception as exc:  # reported to the user on the GUI thread
            result = exc
        self.finished.emit(result)


class ScanFolderAction(BaseAction):
    """Tools menu: scan a folder and store new or changed embedded lyrics."""

    TITLE = 'Scan folder into lyrics cache...'
    MENU = (PLUGIN_NAME,)

    def callback(self, objs):
        global _scan_job
        api = self.api
        if _cache is None:
            QMessageBox.warning(None, PLUGIN_NAME, 'The lyrics cache is not open. See the log.')
            return
        if _scan_job is not None:
            QMessageBox.information(None, PLUGIN_NAME, 'A scan is already running.')
            return

        folder = QFileDialog.getExistingDirectory(
            None, 'Folder to scan for lyrics', api.plugin_persist['last_scan_folder']
        )
        if not folder:
            return
        api.plugin_persist['last_scan_folder'] = folder

        dialog = QProgressDialog(f'Scanning {folder}', 'Cancel', 0, 0)
        dialog.setWindowTitle(PLUGIN_NAME)
        dialog.setMinimumDuration(0)
        dialog.setAutoClose(False)
        dialog.setAutoReset(False)

        job = ScanJob(folder)
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
        api.logger.info('Lyrics cache: scanning %s', folder)
        job.start()
        dialog.show()


def _report_scan(api: PluginApi, folder: str, result) -> None:
    if isinstance(result, Exception):
        api.logger.error('Lyrics cache: scan of %s failed: %s', folder, result)
        QMessageBox.warning(None, PLUGIN_NAME, f'The scan failed.\n\n{result}')
        return

    stats: ScanStats = result
    for path in stats.conflict_files:
        api.logger.info('Lyrics cache: %s has lyrics that differ from the cached ones; kept the cached ones', path)
    for path, message in stats.error_samples:
        api.logger.warning('Lyrics cache: cannot read %s: %s', path, message)

    summary = format_summary(stats, folder, _cache.count() if _cache else None)
    if stats.conflicts or stats.errors:
        summary += '\nThe log names the files with conflicts or read errors.'
    if stats.queued:
        summary += '\nRun scripts/shironet_worker.py run to fetch the queued songs.'
    api.logger.info('Lyrics cache: %s', summary.replace('\n\n', ' | ').replace('\n', ', '))
    QMessageBox.information(None, PLUGIN_NAME, summary)


def enable(api: PluginApi) -> None:
    global _api, _cache
    _api = api
    api.plugin_persist.register_option('last_scan_folder', '')

    path = _db_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        _cache = LyricsCache(path)
    except (OSError, sqlite3.Error, RuntimeError) as exc:
        api.logger.error('Lyrics cache: cannot open %s: %s', path, exc)
        return
    if _cache.cleanup_counts:
        api.logger.info(
            'Lyrics cache: cleaned stored lyrics (prefixes, credit headers, placeholders): '
            '%d updated, %d removed',
            *_cache.cleanup_counts,
        )
    api.logger.info('Lyrics cache: using %s (%d songs)', path, _cache.count())

    api.register_file_post_load_processor(_on_file_loaded)
    api.register_file_pre_save_processor(_on_file_pre_save)
    api.register_file_post_save_processor(_on_file_saved)
    api.register_file_post_addition_to_track_processor(_on_file_added_to_track)
    api.register_tools_menu_action(ScanFolderAction)
    for register in (
        api.register_file_action,
        api.register_track_action,
        api.register_album_action,
        api.register_cluster_action,
        api.register_clusterlist_action,
    ):
        register(LookupAction)


def disable() -> None:
    global _cache, _scan_job
    if _scan_job is not None:
        _scan_job.stop(wait=5.0)
        _scan_job = None
    _lyrics_before_save.clear()
    if _cache is not None:
        _cache.close()
        _cache = None
