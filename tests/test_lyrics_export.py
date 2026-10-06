import os
import tempfile
import unittest
from unittest import mock

import _support

_support.load_plugin_package()
HAVE_MUTAGEN = _support.load_mutagen()

# lyrics_export imports mutagen, so without mutagen every test here is skipped.
if HAVE_MUTAGEN:
    from mutagen.flac import FLAC
    from mutagen.id3 import ID3, SYLT, TIT2, USLT

    from shironet_lyrics.src import lyrics_export
    from shironet_lyrics.src.lyrics_export import (
        LRC,
        TXT,
        Outcome,
        export_file,
        is_lrc,
        lrc_time,
        read_file_lyrics,
        sidecar_path,
        sylt_to_lrc,
    )
    from test_tag_reader import write_empty_flac, write_silent_mp3

SKIP_REASON = 'mutagen not found (install Picard 3 or set PICARD_EXE)'


LRC_TEXT = '[ar:Artist]\n[00:01.00]שורה ראשונה\n[00:05.50]Second line\n[01:02.03]שורה שלישית'


@unittest.skipUnless(HAVE_MUTAGEN, SKIP_REASON)
class LrcTest(unittest.TestCase):
    def test_is_lrc(self):
        self.assertTrue(is_lrc(LRC_TEXT))
        self.assertTrue(is_lrc('[00:01]a\n[00:02:50]b'))
        self.assertTrue(is_lrc('[00:01.00][00:30.00]chorus\n[00:10.00]verse'))

    def test_plain_text_is_not_lrc(self):
        self.assertFalse(is_lrc('שורה ראשונה\nשורה שנייה'))
        self.assertFalse(is_lrc('[Chorus]\nLa la\n[Verse 2]\nMore'))
        self.assertFalse(is_lrc('[00:01.00]one timed line\nthen plain\nand plain\nand plain'))
        self.assertFalse(is_lrc('[ar:Artist]\n[ti:Title]'))

    def test_lrc_time(self):
        self.assertEqual(lrc_time(0), '[00:00.00]')
        self.assertEqual(lrc_time(61234), '[01:01.23]')
        self.assertEqual(lrc_time(3723450), '[62:03.45]')

    def test_sylt_to_lrc(self):
        entries = [('second\n', 5500), ('\nfirst', 1000), ('\r\nthird', 62030)]
        self.assertEqual(sylt_to_lrc(entries), '[00:01.00]first\n[00:05.50]second\n[01:02.03]third')

    def test_sidecar_keeps_the_name(self):
        path = os.path.join('x', '01 - שיר.v2.mp3')
        self.assertEqual(sidecar_path(path, 'lrc'), os.path.join('x', '01 - שיר.v2.lrc'))
        self.assertEqual(sidecar_path('Song.FLAC', 'txt'), 'Song.txt')


@unittest.skipUnless(HAVE_MUTAGEN, SKIP_REASON)
class ExportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def mp3(self, name, uslt=None, sylt=None, desc=''):
        path = os.path.join(self.tmp.name, name)
        write_silent_mp3(path)
        tags = ID3()
        tags.add(TIT2(encoding=3, text=['title']))
        if uslt is not None:
            tags.add(USLT(encoding=3, lang='heb', desc=desc, text=uslt))
        if sylt is not None:
            tags.add(SYLT(encoding=3, lang='heb', format=2, type=1, desc='', text=sylt))
        tags.save(path)
        return path

    def flac(self, name, **fields):
        path = os.path.join(self.tmp.name, name)
        write_empty_flac(path)
        audio = FLAC(path)
        audio.add_tags()
        for key, value in fields.items():
            audio[key] = [value]
        audio.save()
        return path

    def read(self, path):
        with open(path, encoding='utf-8') as f:
            return f.read()

    def test_hebrew_plain_lyrics_to_txt(self):
        path = self.mp3('01 - שיר.mp3', uslt='שורה ראשונה\r\nשורה שנייה  \r\n')
        outcome, target, lyrics = export_file(path)
        self.assertEqual((outcome, lyrics.kind, lyrics.source), (Outcome.WRITTEN, TXT, 'USLT'))
        self.assertEqual(target, os.path.join(self.tmp.name, '01 - שיר.txt'))
        self.assertEqual(self.read(target), 'שורה ראשונה\nשורה שנייה\n')

    def test_english_lyrics_with_described_frame(self):
        path = self.mp3('song.mp3', uslt='First line\nSecond line', desc='eng')
        outcome, target, _ = export_file(path)
        self.assertEqual(outcome, Outcome.WRITTEN)
        self.assertEqual(self.read(target), 'First line\nSecond line\n')

    def test_sylt_becomes_lrc_and_wins_over_uslt(self):
        path = self.mp3('synced.mp3', uslt='plain', sylt=[('שורה', 1000), ('line', 5500)])
        outcome, target, lyrics = export_file(path)
        self.assertEqual((lyrics.kind, lyrics.source), (LRC, 'SYLT'))
        self.assertTrue(target.endswith('synced.lrc'))
        self.assertEqual(self.read(target), '[00:01.00]שורה\n[00:05.50]line\n')

    def test_lrc_text_in_the_lyrics_tag_becomes_lrc(self):
        path = self.flac('timed.flac', LYRICS=LRC_TEXT)
        outcome, target, lyrics = export_file(path)
        self.assertEqual((lyrics.kind, lyrics.source), (LRC, 'LYRICS'))
        self.assertEqual(self.read(target), LRC_TEXT + '\n')

    def test_language_prefix_is_removed_and_credits_kept(self):
        text = 'heb||שם השיר\nמילים: כותב\n\nשורה ראשונה'
        path = self.flac('prefixed.flac', UNSYNCEDLYRICS=text)
        _, target, _ = export_file(path)
        self.assertEqual(self.read(target), 'שם השיר\nמילים: כותב\n\nשורה ראשונה\n')

    def test_clean_removes_credits_and_placeholders(self):
        credits = self.flac('credits.flac', LYRICS='שם השיר\nמילים: כותב\n\nשורה ראשונה')
        _, target, _ = export_file(credits, clean=True)
        self.assertEqual(self.read(target), 'שורה ראשונה\n')
        placeholder = self.flac('instrumental.flac', LYRICS='[Instrumental]')
        self.assertEqual(export_file(placeholder, clean=True)[0], Outcome.NO_LYRICS)
        self.assertFalse(os.path.exists(sidecar_path(placeholder, TXT)))

    def test_existing_sidecar_skips_without_reading_tags(self):
        path = self.mp3('done.mp3', uslt='new text')
        for kind in (LRC, TXT):
            sidecar = sidecar_path(path, kind)
            with open(sidecar, 'w', encoding='utf-8') as f:
                f.write('old')
            with mock.patch.object(lyrics_export, 'read_file_lyrics', wraps=read_file_lyrics) as reader:
                outcome, target, lyrics = export_file(path)
            self.assertEqual((outcome, target, lyrics), (Outcome.EXISTS, sidecar, None))
            reader.assert_not_called()
            self.assertEqual(self.read(sidecar), 'old')
            os.remove(sidecar)

    def test_overwrite(self):
        path = self.mp3('again.mp3', uslt='new text')
        sidecar = sidecar_path(path, TXT)
        with open(sidecar, 'w', encoding='utf-8') as f:
            f.write('old')
        self.assertEqual(export_file(path, overwrite=True)[0], Outcome.WRITTEN)
        self.assertEqual(self.read(sidecar), 'new text\n')
        self.assertEqual(export_file(path, overwrite=True)[0], Outcome.UNCHANGED)

    def test_dry_run_writes_nothing(self):
        path = self.mp3('dry.mp3', uslt='text')
        outcome, target, _ = export_file(path, dry_run=True)
        self.assertEqual(outcome, Outcome.WRITTEN)
        self.assertFalse(os.path.exists(target))

    def test_no_lyrics_and_unknown_format(self):
        self.assertEqual(export_file(self.mp3('empty.mp3'))[0], Outcome.NO_LYRICS)
        other = os.path.join(self.tmp.name, 'notes.xyz')
        with open(other, 'wb') as f:
            f.write(b'not audio')
        self.assertEqual(export_file(other)[0], Outcome.UNSUPPORTED)


if __name__ == '__main__':
    unittest.main()
