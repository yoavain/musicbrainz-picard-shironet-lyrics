import os
import tempfile
import unittest

import _support

_support.load_plugin_package()

from shironet_lyrics.plugin.scan_state import ScanState  # noqa: E402
from shironet_lyrics.plugin.scanner import format_summary, scan_folder  # noqa: E402
from shironet_lyrics.plugin.server_client import Answer, ServerUnavailable  # noqa: E402

EXTENSIONS = frozenset({'.mp3', '.flac'})


class FileTags:
    """What read_tags returns (the real one needs mutagen): artist, title, lyrics."""

    def __init__(self, artist, title, lyrics):
        self.artist, self.title, self.lyrics = artist, title, lyrics


class FakeClient:
    """Records calls; answers PUT and fetch from the given functions."""

    def __init__(self, put=None, fetch=None):
        self.calls = []
        self._put = put or (lambda song, lyrics: Answer(200, {'result': 'added'}))
        self._fetch = fetch or (lambda song: Answer(202, {'status': 'queued', 'position': 1}))

    def put(self, song, lyrics, ref, replace):
        self.calls.append(('put', song, lyrics, ref, replace))
        return self._put(song, lyrics)

    def fetch(self, song, priority):
        self.calls.append(('fetch', song, priority))
        return self._fetch(song)


class ScanFolderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.state = ScanState(':memory:')
        self.tags = {}

    def tearDown(self):
        self.state.close()
        self.tmp.cleanup()

    def add(self, name, tags):
        path = os.path.join(self.root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(b'x')
        self.tags[path] = tags
        return path

    def read_tags(self, path):
        value = self.tags[path]
        if isinstance(value, Exception):
            raise value
        return value

    def scan(self, client, should_stop=None):
        return scan_folder(self.state, client, self.root, self.read_tags, EXTENSIONS, should_stop=should_stop)

    def test_a_file_with_lyrics_is_sent_as_written_and_not_read_again(self):
        path = self.add('a.mp3', FileTags('דן תורן', 'אוטו כחול', 'heb||שורה\r\n'))
        client = FakeClient()
        stats = self.scan(client)
        self.assertEqual(client.calls, [('put', {'artist': 'דן תורן', 'title': 'אוטו כחול'}, 'heb||שורה\r\n', os.path.normcase(os.path.abspath(path)), False)])
        self.assertEqual((stats.read, stats.with_lyrics, stats.added), (1, 1, 1))
        again = FakeClient()
        stats = self.scan(again)
        self.assertEqual((stats.unchanged, again.calls), (1, []))

    def test_a_file_without_lyrics_is_fetched_each_scan_from_the_recorded_names(self):
        self.add('b.mp3', FileTags('דן תורן', 'טוב לי', ''))
        client = FakeClient()
        stats = self.scan(client)
        self.assertEqual(client.calls, [('fetch', {'artist': 'דן תורן', 'title': 'טוב לי'}, 'bulk')])
        self.assertEqual(stats.queued, 1)
        again = FakeClient(fetch=lambda song: Answer(200, {'status': 'found', 'lyrics': 'שורה'}))
        stats = self.scan(again)
        self.assertEqual(again.calls, [('fetch', {'artist': 'דן תורן', 'title': 'טוב לי'}, 'bulk')])
        self.assertEqual((stats.unchanged, stats.cached), (1, 1))

    def test_lyrics_the_server_skips_count_as_no_lyrics(self):
        self.add('c.mp3', FileTags('דן תורן', 'שיר', 'instrumental'))
        client = FakeClient(put=lambda song, lyrics: Answer(200, {'result': 'skipped'}))
        stats = self.scan(client)
        self.assertEqual([call[0] for call in client.calls], ['put', 'fetch'])
        self.assertEqual(stats.queued, 1)
        self.assertEqual(self.scan(FakeClient()).unchanged, 1)

    def test_answers_are_counted(self):
        self.add('d1.mp3', FileTags('Band', 'Song', 'English words'))
        self.add('d2.mp3', FileTags('אמן', 'קונפליקט', 'אחר'))
        self.add('d3.mp3', FileTags('Band', 'Other', ''))
        self.add('d4.mp3', FileTags('אמן', 'חסר', ''))
        results = {'Song': 'not_hebrew', 'קונפליקט': 'conflict'}
        fetches = {'Other': Answer(422, {'status': 'not_hebrew'}), 'חסר': Answer(404, {'status': 'not_found', 'retryAfter': 'x'})}
        client = FakeClient(put=lambda song, lyrics: Answer(200, {'result': results[song['title']]}),
                            fetch=lambda song: fetches[song['title']])
        stats = self.scan(client)
        self.assertEqual((stats.not_hebrew, stats.conflicts, stats.not_found), (2, 1, 1))
        self.assertEqual(stats.conflict_files, [os.path.join(self.root, 'd2.mp3')])

    def test_a_file_without_a_name_is_recorded_without_a_call(self):
        self.add('e.mp3', FileTags('', '', ''))
        self.add('f.flac', None)  # unknown format
        client = FakeClient()
        self.scan(client)
        self.assertEqual(client.calls, [])
        self.assertEqual(self.scan(FakeClient()).unchanged, 2)

    def test_an_unreadable_file_is_counted_and_read_again_next_time(self):
        self.add('g.mp3', OSError('locked'))
        stats = self.scan(FakeClient())
        self.assertEqual((stats.errors, len(stats.error_samples)), (1, 1))
        self.assertEqual(self.scan(FakeClient()).errors, 1)

    def test_the_server_going_away_stops_the_scan_and_keeps_what_was_answered(self):
        self.add('h1.mp3', FileTags('אמן', 'ראשון', ''))
        self.add('h2.mp3', FileTags('אמן', 'שני', ''))
        answers = [Answer(202, {'status': 'queued'})]

        def fetch(song):
            if not answers:
                raise ServerUnavailable('connection refused')
            return answers.pop()

        stats = self.scan(FakeClient(fetch=fetch))
        self.assertIn('connection refused', stats.server_error)
        self.assertEqual(stats.queued, 1)
        second = self.scan(FakeClient())
        self.assertEqual((second.unchanged, second.read), (1, 1))  # h2 was not recorded

    def test_stop_request(self):
        self.add('i1.mp3', FileTags('אמן', 'א', ''))
        self.add('i2.mp3', FileTags('אמן', 'ב', ''))
        stats = self.scan(FakeClient(), should_stop=lambda: True)
        self.assertTrue(stats.cancelled)
        self.assertEqual(stats.read, 0)

    def test_summary_mentions_the_server_error(self):
        self.add('j.mp3', FileTags('אמן', 'שיר', ''))
        stats = self.scan(FakeClient(fetch=lambda song: (_ for _ in ()).throw(ServerUnavailable('down'))))
        self.assertIn('down', format_summary(stats, self.root))


if __name__ == '__main__':
    unittest.main()
