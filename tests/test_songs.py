import os
import unittest

import _support

_support.load_plugin_package()

from shironet_lyrics.plugin.songs import file_ref, raw_lyrics, song_payload  # noqa: E402


class FakeMetadata:
    """The part of Picard's Metadata that raw_lyrics() uses."""

    def __init__(self, tags):
        self._tags = {name: value if isinstance(value, list) else [value] for name, value in tags.items()}

    def keys(self):
        return self._tags.keys()

    def getall(self, name):
        return self._tags.get(name, [])


class SongPayloadTest(unittest.TestCase):
    def test_own_tags_first_musicbrainz_name_as_alternate(self):
        self.assertEqual(
            song_payload(('Dan Toren', 'Oto Kachol'), ('דן תורן', 'אוטו כחול'), 'heb'),
            {'artist': 'Dan Toren', 'title': 'Oto Kachol', 'alt': {'artist': 'דן תורן', 'title': 'אוטו כחול'}, 'language': 'heb'},
        )

    def test_same_names_send_no_alternate(self):
        self.assertEqual(song_payload(('דן תורן', 'אוטו כחול'), ('דן תורן', 'אוטו כחול'), None),
                         {'artist': 'דן תורן', 'title': 'אוטו כחול'})

    def test_empty_own_tags_use_the_musicbrainz_name(self):
        self.assertEqual(song_payload(('', ''), ('דן תורן', 'אוטו כחול'), ''), {'artist': 'דן תורן', 'title': 'אוטו כחול'})
        self.assertEqual(song_payload((None, 'שיר'), ('דן תורן', 'אוטו כחול'), None), {'artist': 'דן תורן', 'title': 'אוטו כחול'})

    def test_an_incomplete_musicbrainz_name_is_no_alternate(self):
        self.assertEqual(song_payload(('דן תורן', 'אוטו כחול'), ('', 'x'), None), {'artist': 'דן תורן', 'title': 'אוטו כחול'})

    def test_no_complete_name_gives_none(self):
        self.assertIsNone(song_payload(('', ''), (None, None), 'heb'))

    def test_names_are_stripped(self):
        self.assertEqual(song_payload((' דן תורן ', 'אוטו כחול\n'), (None, None), None), {'artist': 'דן תורן', 'title': 'אוטו כחול'})


class RawLyricsTest(unittest.TestCase):
    def test_plain_lyrics_as_they_are(self):
        self.assertEqual(raw_lyrics(FakeMetadata({'lyrics': 'heb||שורה\r\n'})), 'heb||שורה\r\n')

    def test_plain_wins_over_described(self):
        self.assertEqual(raw_lyrics(FakeMetadata({'lyrics:eng': 'described', 'lyrics': 'plain'})), 'plain')

    def test_described_when_plain_is_blank(self):
        self.assertEqual(raw_lyrics(FakeMetadata({'lyrics': ' ', 'lyrics:b': 'second', 'lyrics:a': 'first'})), 'first')

    def test_no_lyrics(self):
        self.assertEqual(raw_lyrics(FakeMetadata({'title': 't', 'syncedlyrics': '[00:01.00]x'})), '')


class FileRefTest(unittest.TestCase):
    def test_matches_the_python_cache_form(self):
        self.assertEqual(file_ref('a.mp3'), os.path.normcase(os.path.abspath('a.mp3')))


if __name__ == '__main__':
    unittest.main()
