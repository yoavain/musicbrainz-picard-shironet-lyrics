import os
import tempfile
import unittest

import _support

_support.load_plugin_package()

from shironet_lyrics.plugin.lyrics_import import format_summary, import_folder, sidecar_lyrics  # noqa: E402
from shironet_lyrics.plugin.server_client import Answer, ServerUnavailable  # noqa: E402

EXTENSIONS = frozenset({'.mp3', '.flac'})


class FileTags:
    """What read_tags returns (the real one needs mutagen): artist, title, lyrics."""

    def __init__(self, artist, title, lyrics):
        self.artist, self.title, self.lyrics = artist, title, lyrics


class FakeClient:
    """Records PUT calls; answers from the given function. Has no fetch: import never queues."""

    def __init__(self, put=None):
        self.calls = []
        self._put = put or (lambda song, lyrics: Answer(200, {'result': 'added'}))

    def put(self, song, lyrics, ref, replace):
        self.calls.append((song, lyrics, ref, replace))
        return self._put(song, lyrics)


class ImportFolderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.tags = {}

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, name, tags, sidecars=None):
        path = os.path.join(self.root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(b'x')
        for extension, content in (sidecars or {}).items():
            with open(os.path.splitext(path)[0] + extension, 'wb') as f:
                f.write(content.encode('utf-8') if isinstance(content, str) else content)
        self.tags[path] = tags
        return path

    def read_tags(self, path):
        value = self.tags[path]
        if isinstance(value, Exception):
            raise value
        return value

    def run_import(self, client, dry_run=False, should_stop=None):
        return import_folder(client, self.root, self.read_tags, EXTENSIONS, dry_run, should_stop=should_stop)

    def test_tag_lyrics_are_sent_as_written_in_any_language(self):
        path = self.add('a.mp3', FileTags('R.E.M.', 'The One I Love', 'This one goes out\r\n'))
        client = FakeClient()
        stats = self.run_import(client)
        self.assertEqual(client.calls, [({'artist': 'R.E.M.', 'title': 'The One I Love'}, 'This one goes out\r\n',
                                         os.path.normcase(os.path.abspath(path)), False)])
        self.assertEqual((stats.read, stats.from_tags, stats.added), (1, 1, 1))

    def test_every_run_reads_every_file(self):
        self.add('a.mp3', FileTags('Band', 'Song', 'Words'))
        self.run_import(FakeClient())
        again = FakeClient(put=lambda song, lyrics: Answer(200, {'result': 'same'}))
        self.assertEqual(self.run_import(again).same, 1)
        self.assertEqual(len(again.calls), 1)

    def test_tag_lyrics_win_over_a_sidecar(self):
        self.add('a.mp3', FileTags('Band', 'Song', 'From tags'), {'.txt': 'From sidecar'})
        client = FakeClient()
        stats = self.run_import(client)
        self.assertEqual(client.calls[0][1], 'From tags')
        self.assertEqual((stats.from_tags, stats.from_sidecar), (1, 0))

    def test_a_txt_sidecar_is_the_fallback(self):
        self.add('a.mp3', FileTags('Band', 'Song', '  '), {'.txt': '﻿Line 1\nLine 2\n'})
        client = FakeClient()
        stats = self.run_import(client)
        self.assertEqual(client.calls[0][1], 'Line 1\nLine 2\n')
        self.assertEqual(stats.from_sidecar, 1)

    def test_an_lrc_sidecar_is_sent_without_time_tags(self):
        self.add('a.mp3', FileTags('Band', 'Song', ''), {'.lrc': '[ar:Band]\n[00:01.00]Line 1\n[00:02.00]Line 2\n'})
        client = FakeClient()
        self.run_import(client)
        self.assertEqual(client.calls[0][1], 'Line 1\nLine 2')

    def test_a_timed_txt_sidecar_is_sent_without_time_tags(self):
        self.add('a.mp3', FileTags('Band', 'Song', ''), {'.txt': '[00:01.00]Line 1\n[00:02.00]Line 2\n'})
        self.assertEqual(sidecar_lyrics(os.path.join(self.root, 'a.mp3')), 'Line 1\nLine 2')

    def test_an_empty_txt_gives_way_to_the_lrc(self):
        self.add('a.mp3', FileTags('Band', 'Song', ''), {'.txt': '\n', '.lrc': '[00:01.00]A\n[00:02.00]B'})
        self.assertEqual(sidecar_lyrics(os.path.join(self.root, 'a.mp3')), 'A\nB')

    def test_files_without_lyrics_or_names_are_counted_without_a_call(self):
        self.add('a.mp3', FileTags('Band', 'Song', ''))
        self.add('b.mp3', FileTags('', 'Song', 'Words'), {'.txt': 'Words'})
        self.add('c.flac', None)  # unknown format
        client = FakeClient()
        stats = self.run_import(client)
        self.assertEqual(client.calls, [])
        self.assertEqual((stats.no_lyrics, stats.no_name, stats.unsupported), (1, 1, 1))

    def test_answers_are_counted(self):
        results = {'1': 'added', '2': 'same', '3': 'replaced', '4': 'conflict', '5': 'skipped'}
        for title in results:
            self.add(f'{title}.mp3', FileTags('Band', title, 'Words'))
        stats = self.run_import(FakeClient(put=lambda song, lyrics: Answer(200, {'result': results[song['title']]})))
        self.assertEqual((stats.added, stats.same, stats.replaced, stats.conflicts, stats.skipped), (1, 1, 1, 1, 1))
        self.assertEqual(stats.conflict_files, [os.path.join(self.root, '4.mp3')])

    def test_a_dry_run_counts_and_sends_nothing(self):
        self.add('a.mp3', FileTags('Band', 'Song', 'Words'))
        self.add('b.mp3', FileTags('Band', 'Other', ''), {'.lrc': '[00:01.00]A\n[00:02.00]B'})
        stats = self.run_import(None, dry_run=True)
        self.assertEqual((stats.from_tags, stats.from_sidecar, stats.added), (1, 1, 0))
        self.assertIn('Would send: from tags 1, from sidecar files 1', format_summary(stats, self.root, dry_run=True))

    def test_unreadable_files_and_sidecars_are_counted(self):
        self.add('a.mp3', OSError('locked'))
        self.add('b.mp3', FileTags('Band', 'Song', ''), {'.txt': b'\xff\xfe not utf-8 \x80'})
        stats = self.run_import(FakeClient())
        self.assertEqual((stats.errors, len(stats.error_samples)), (2, 2))

    def test_the_server_going_away_stops_the_import(self):
        self.add('a1.mp3', FileTags('Band', 'One', 'Words'))
        self.add('a2.mp3', FileTags('Band', 'Two', 'Words'))
        answers = [Answer(200, {'result': 'added'})]

        def put(song, lyrics):
            if not answers:
                raise ServerUnavailable('connection refused')
            return answers.pop()

        stats = self.run_import(FakeClient(put=put))
        self.assertEqual(stats.added, 1)
        self.assertIn('connection refused', format_summary(stats, self.root))

    def test_stop_request(self):
        self.add('a.mp3', FileTags('Band', 'Song', 'Words'))
        stats = self.run_import(FakeClient(), should_stop=lambda: True)
        self.assertTrue(stats.cancelled)
        self.assertEqual(stats.read, 0)


if __name__ == '__main__':
    unittest.main()
