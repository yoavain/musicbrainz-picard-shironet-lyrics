import os
import sqlite3
import tempfile
import unittest

import _support

_support.load_plugin_package()

from shironet_lyrics.plugin.scan_state import ScanState, ScannedFile  # noqa: E402

OLD_CACHE_SCHEMA = """
CREATE TABLE scanned_files (path TEXT PRIMARY KEY, mtime_ns INTEGER NOT NULL, size INTEGER NOT NULL,
  scanned_at TEXT NOT NULL, artist TEXT, title TEXT, has_lyrics INTEGER) WITHOUT ROWID;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES ('schema_version', '6');
"""


class ScanStateTest(unittest.TestCase):
    def setUp(self):
        self.state = ScanState(':memory:')

    def tearDown(self):
        self.state.close()

    def test_scanned_files(self):
        self.assertIsNone(self.state.scanned_file('a.mp3', 100, 10))
        self.state.mark_scanned('a.mp3', 100, 10, 'אמן', 'שיר', False)
        self.assertEqual(self.state.scanned_file('a.mp3', 100, 10), ScannedFile('אמן', 'שיר', False))
        self.assertEqual(self.state.scanned_file(os.path.abspath('a.mp3'), 100, 10), ScannedFile('אמן', 'שיר', False))
        self.assertIsNone(self.state.scanned_file('a.mp3', 101, 10))
        self.assertIsNone(self.state.scanned_file('a.mp3', 100, 11))

    def test_a_file_read_without_has_lyrics_needs_another_read(self):
        self.state.mark_scanned('a.mp3', 100, 10)
        self.assertIsNone(self.state.scanned_file('a.mp3', 100, 10))

    def test_batch_rolls_back_on_error(self):
        with self.assertRaises(ValueError):
            with self.state.batch():
                self.state.mark_scanned('a.mp3', 1, 1, 'א', 'ב', True)
                raise ValueError
        self.assertIsNone(self.state.scanned_file('a.mp3', 1, 1))


class CopyFromOldCacheTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.path.join(self.tmp.name, 'lyrics.sqlite3')
        self.new = os.path.join(self.tmp.name, 'scan-state.sqlite3')
        conn = sqlite3.connect(self.old)
        conn.executescript(OLD_CACHE_SCHEMA)
        conn.execute("INSERT INTO scanned_files VALUES (?, 5, 6, 'x', 'אמן', 'שיר', 1)", (os.path.normcase(os.path.abspath('a.mp3')),))
        conn.execute("INSERT INTO scanned_files VALUES (?, 7, 8, 'x', NULL, NULL, NULL)", (os.path.normcase(os.path.abspath('b.mp3')),))
        conn.commit()
        conn.close()

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_new_state_file_copies_the_old_cache_once(self):
        state = ScanState.open(self.new, old_cache=self.old)
        self.assertEqual(state.copied_from_old_cache, 2)
        self.assertEqual(state.scanned_file('a.mp3', 5, 6), ScannedFile('אמן', 'שיר', True))
        self.assertIsNone(state.scanned_file('b.mp3', 7, 8))  # read before schema 6: read again
        state.close()
        again = ScanState.open(self.new, old_cache=self.old)
        self.assertEqual(again.copied_from_old_cache, 0)
        again.close()

    def test_the_old_cache_is_not_changed(self):
        before = os.path.getmtime(self.old), os.path.getsize(self.old)
        ScanState.open(self.new, old_cache=self.old).close()
        self.assertEqual((os.path.getmtime(self.old), os.path.getsize(self.old)), before)

    def test_no_old_cache_is_fine(self):
        state = ScanState.open(self.new, old_cache=os.path.join(self.tmp.name, 'missing.sqlite3'))
        self.assertEqual(state.copied_from_old_cache, 0)
        state.close()


if __name__ == '__main__':
    unittest.main()
