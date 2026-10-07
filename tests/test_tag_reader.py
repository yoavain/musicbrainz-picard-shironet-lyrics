import os
import struct
import tempfile
import unittest

import _support

_support.load_plugin_package()
HAVE_MUTAGEN = _support.load_mutagen()

if HAVE_MUTAGEN:
    import mutagen
    from mutagen.flac import FLAC
    from mutagen.id3 import ID3, TIT2, TPE1, USLT

    from shironet_lyrics.plugin.tag_reader import read_tags


# One MPEG-1 Layer III frame: 128 kbit/s, 44.1 kHz, 417 bytes.
MP3_FRAME = b'\xff\xfb\x90\x64' + b'\x00' * 413


def write_silent_mp3(path):
    with open(path, 'wb') as f:
        f.write(MP3_FRAME * 20)


def write_empty_flac(path):
    """A FLAC stream with only a STREAMINFO block (44.1 kHz, stereo, 16 bit)."""
    sample_info = (44100 << 44) | (1 << 41) | (15 << 36)  # rate, channels-1, bits-1, 0 samples
    streaminfo = struct.pack('>HH', 4096, 4096) + b'\x00' * 6 + sample_info.to_bytes(8, 'big') + b'\x00' * 16
    header = bytes([0x80]) + len(streaminfo).to_bytes(3, 'big')  # last block, type STREAMINFO
    with open(path, 'wb') as f:
        f.write(b'fLaC' + header + streaminfo)


@unittest.skipUnless(HAVE_MUTAGEN, 'mutagen not found (install Picard 3 or set PICARD_EXE)')
class ReadTagsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def path(self, name):
        return os.path.join(self.tmp.name, name)

    def test_mp3_with_plain_uslt(self):
        path = self.path('a.mp3')
        write_silent_mp3(path)
        tags = ID3()
        tags.add(TPE1(encoding=3, text=['להקת הנח"ל']))
        tags.add(TIT2(encoding=3, text=['שיר לשלום']))
        tags.add(USLT(encoding=3, lang='heb', desc='', text='שורה ראשונה\r\nשורה שנייה'))
        tags.save(path)

        result = read_tags(path)

        self.assertEqual(result.artist, 'להקת הנח"ל')
        self.assertEqual(result.title, 'שיר לשלום')
        self.assertEqual(result.lyrics, 'שורה ראשונה\r\nשורה שנייה')  # as written: the server cleans

    def test_mp3_prefers_uslt_without_description_and_joins_artists(self):
        path = self.path('b.mp3')
        write_silent_mp3(path)
        tags = ID3()
        tags.add(TPE1(encoding=3, text=['One', 'Two']))
        tags.add(TIT2(encoding=3, text=['Song']))
        tags.add(USLT(encoding=3, lang='eng', desc='alt', text='described'))
        tags.add(USLT(encoding=3, lang='eng', desc='', text='plain'))
        tags.save(path)

        result = read_tags(path)

        self.assertEqual(result.artist, 'One; Two')
        self.assertEqual(result.lyrics, 'plain')

    def test_mp3_without_tags(self):
        path = self.path('c.mp3')
        write_silent_mp3(path)
        result = read_tags(path)
        self.assertEqual((result.artist, result.title, result.lyrics), ('', '', ''))

    def test_flac_lyrics(self):
        path = self.path('d.flac')
        write_empty_flac(path)
        audio = FLAC(path)
        audio.add_tags()
        audio['ARTIST'] = ['עופרה חזה']
        audio['TITLE'] = ['שיר לשלום']
        audio['LYRICS'] = ['שורה 1\nשורה 2\n']
        audio.save()

        result = read_tags(path)

        self.assertEqual((result.artist, result.title), ('עופרה חזה', 'שיר לשלום'))
        self.assertEqual(result.lyrics, 'שורה 1\nשורה 2\n')

    def test_flac_unsyncedlyrics(self):
        path = self.path('e.flac')
        write_empty_flac(path)
        audio = FLAC(path)
        audio.add_tags()
        audio['ARTIST'] = ['A']
        audio['TITLE'] = ['T']
        audio['UNSYNCEDLYRICS'] = ['from unsynced']
        audio.save()

        self.assertEqual(read_tags(path).lyrics, 'from unsynced')

    def test_flac_written_by_lyricsify_cli_is_returned_as_written(self):
        # lyricsify-cli stored UNSYNCEDLYRICS as "<language>||<lyrics>".
        path = self.path('h.flac')
        write_empty_flac(path)
        audio = FLAC(path)
        audio.add_tags()
        audio['ARTIST'] = ['אטרף']
        audio['TITLE'] = ['שיר הקטר']
        audio['UNSYNCEDLYRICS'] = ['heb||שם השיר\n\nביצוע: להקה\nמילים: כותב\n\nשורה ראשונה']
        audio.save()

        # Returned as written; the server removes the prefix and the credits header.
        self.assertEqual(read_tags(path).lyrics, 'heb||שם השיר\n\nביצוע: להקה\nמילים: כותב\n\nשורה ראשונה')

    def test_unknown_format(self):
        path = self.path('f.xyz')
        with open(path, 'wb') as f:
            f.write(b'not audio at all')
        self.assertIsNone(read_tags(path))

    def test_damaged_file_raises(self):
        # The scanner counts this as an unreadable file and retries it next scan.
        path = self.path('g.mp3')
        with open(path, 'wb') as f:
            f.write(b'not audio at all')
        with self.assertRaises(mutagen.MutagenError):
            read_tags(path)


if __name__ == '__main__':
    unittest.main()
