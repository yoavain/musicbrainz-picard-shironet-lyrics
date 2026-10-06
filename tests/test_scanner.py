import os
import tempfile
import unittest

import _support

_support.load_plugin_package()

from shironet_lyrics.src.lyrics_cache import LyricsCache  # noqa: E402
from shironet_lyrics.src.scanner import ScanStats, format_summary, scan_folder  # noqa: E402


EXTENSIONS = frozenset({'.mp3', '.flac'})
# A Hebrew artist makes every test song Hebrew, so the scanner stores it.
ARTIST = 'משינה'


class Tags:
    def __init__(self, artist, title, lyrics):
        self.artist, self.title, self.lyrics = artist, title, lyrics


class FakeReader:
    """Returns tags set per path; raises for paths in `failing`."""

    def __init__(self):
        self.tags = {}
        self.failing = set()
        self.calls = []

    def __call__(self, path):
        self.calls.append(os.path.basename(path))
        if path in self.failing:
            raise OSError('cannot read')
        return self.tags.get(path)


class ScanFolderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, 'music')
        os.makedirs(os.path.join(self.root, 'album'))
        self.cache = LyricsCache(os.path.join(self.tmp.name, 'cache.sqlite3'))
        self.reader = FakeReader()

    def tearDown(self):
        self.cache.close()
        self.tmp.cleanup()

    def add_file(self, name, tags, content=b'audio'):
        path = os.path.join(self.root, 'album', name)
        with open(path, 'wb') as f:
            f.write(content)
        self.reader.tags[path] = tags
        return path

    def scan(self, **kwargs):
        self.reader.calls.clear()
        return scan_folder(self.cache, self.root, self.reader, EXTENSIONS, **kwargs)

    def test_first_scan_stores_lyrics(self):
        self.add_file('1.mp3', Tags(ARTIST, 'One', 'lyrics one'))
        self.add_file('2.flac', Tags(ARTIST, 'Two', ''))
        self.add_file('cover.jpg', None)

        stats = self.scan()

        self.assertEqual((stats.found, stats.read, stats.with_lyrics, stats.added), (2, 2, 1, 1))
        self.assertEqual(self.cache.get(ARTIST, 'one').lyrics, 'lyrics one')
        self.assertEqual(sorted(self.reader.calls), ['1.mp3', '2.flac'])

    def test_rescan_reads_only_new_and_changed_files(self):
        changed = self.add_file('1.mp3', Tags(ARTIST, 'One', 'old'))
        self.add_file('2.mp3', Tags(ARTIST, 'Two', 'two'))
        self.scan()

        with open(changed, 'ab') as f:
            f.write(b' edited')
        self.reader.tags[changed] = Tags(ARTIST, 'One', 'new')
        self.add_file('3.mp3', Tags(ARTIST, 'Three', 'three'))

        stats = self.scan()

        self.assertEqual(sorted(self.reader.calls), ['1.mp3', '3.mp3'])
        self.assertEqual((stats.unchanged, stats.read, stats.added, stats.replaced), (1, 2, 1, 1))
        self.assertEqual(self.cache.get(ARTIST, 'One').lyrics, 'new')

    def test_files_without_lyrics_are_not_read_again(self):
        self.add_file('1.mp3', Tags(ARTIST, 'One', ''))
        self.add_file('2.mp3', None)  # format the reader does not know
        self.scan()
        stats = self.scan()
        self.assertEqual(self.reader.calls, [])
        self.assertEqual(stats.unchanged, 2)

    def test_conflict_between_two_files_keeps_the_first(self):
        self.add_file('1.mp3', Tags(ARTIST, 'Song', 'first'))
        second = self.add_file('2.mp3', Tags(ARTIST, 'Song (Live)', 'second'))

        stats = self.scan()

        self.assertEqual((stats.added, stats.conflicts), (1, 1))
        self.assertEqual(stats.conflict_files, [second])
        self.assertEqual(self.cache.get(ARTIST, 'Song').lyrics, 'first')

    def test_unreadable_file_is_retried_next_time(self):
        path = self.add_file('1.mp3', Tags(ARTIST, 'One', 'text'))
        self.reader.failing.add(path)

        stats = self.scan()
        self.assertEqual((stats.errors, stats.read), (1, 0))
        self.assertEqual(stats.error_samples[0][0], path)

        self.reader.failing.clear()
        stats = self.scan()
        self.assertEqual((stats.errors, stats.added), (0, 1))

    def test_missing_artist_or_title_is_skipped(self):
        self.add_file('1.mp3', Tags('', 'שיר', 'text'))
        stats = self.scan()
        self.assertEqual((stats.with_lyrics, stats.skipped, stats.added), (1, 1, 0))

    def test_non_hebrew_songs_are_not_cached(self):
        self.add_file('1.mp3', Tags('R.E.M.', 'The One I Love', 'An English placeholder line'))
        self.add_file('2.mp3', Tags('Mashina', 'At Lo Kmo Kulam', 'שורה לדוגמה בעברית'))

        stats = self.scan()

        self.assertEqual((stats.with_lyrics, stats.not_hebrew, stats.added), (2, 1, 1))
        self.assertIsNone(self.cache.get('R.E.M.', 'The One I Love'))
        self.assertIsNotNone(self.cache.get('Mashina', 'At Lo Kmo Kulam'))
        self.assertEqual(self.scan().unchanged, 2)

    def test_cancel_keeps_the_work_done(self):
        for number in range(5):
            self.add_file(f'{number}.mp3', Tags(ARTIST, f'Song {number}', f'text {number}'))
        done = []

        stats = self.scan(progress=lambda index, total: done.append(index), should_stop=lambda: len(done) >= 2)

        self.assertTrue(stats.cancelled)
        self.assertEqual(self.cache.count(), 2)
        stats = self.scan()
        self.assertEqual((stats.unchanged, stats.added), (2, 3))

    def test_progress_reports_every_file(self):
        self.add_file('1.mp3', Tags(ARTIST, 'One', 'x'))
        self.add_file('2.mp3', Tags(ARTIST, 'Two', 'y'))
        calls = []
        self.scan(progress=lambda index, total: calls.append((index, total)))
        self.assertEqual(calls, [(1, 2), (2, 2)])


class FormatSummaryTest(unittest.TestCase):
    def test_summary(self):
        stats = ScanStats(found=3, read=3, with_lyrics=2, not_hebrew=1, added=1)
        text = format_summary(stats, 'C:/music', 10)
        self.assertTrue(text.startswith('Scan finished: C:/music' + chr(10)))
        self.assertIn('Not Hebrew (not cached): 1', text)
        self.assertTrue(text.endswith('Cache now holds 10 songs.'))

    def test_cancelled_and_unknown_count(self):
        text = format_summary(ScanStats(cancelled=True), 'x', None)
        self.assertTrue(text.startswith('Scan cancelled: x'))
        self.assertIn('holds ? songs', text)


if __name__ == '__main__':
    unittest.main()
