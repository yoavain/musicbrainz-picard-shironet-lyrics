import unittest

import _support

_support.load_plugin_package()

from shironet_lyrics.plugin.lyrics_text import clean_lyrics, lrc_to_plain  # noqa: E402


class CleanLyricsTest(unittest.TestCase):
    def test_line_endings_and_trailing_spaces(self):
        self.assertEqual(clean_lyrics('\r\n line 1  \r\nline 2\r\rline 3\n\n'), 'line 1\nline 2\n\nline 3')

    def test_empty(self):
        self.assertEqual(clean_lyrics(None), '')
        self.assertEqual(clean_lyrics(' \n \n'), '')

    def test_language_prefix_is_removed(self):
        self.assertEqual(clean_lyrics('heb||שורה 1\nשורה 2'), 'שורה 1\nשורה 2')
        self.assertEqual(clean_lyrics('eng|None|Line 1'), 'Line 1')
        self.assertEqual(clean_lyrics('eng||\nLine 1'), 'Line 1')

    def test_pipes_inside_lyrics_are_kept(self):
        self.assertEqual(clean_lyrics('a | b | c'), 'a | b | c')
        self.assertEqual(clean_lyrics('Line 1\nheb||Line 2'), 'Line 1\nheb||Line 2')

    def test_title_and_credit_header_is_removed(self):
        text = (
            'שם השיר\n\nביצוע: להקה\nמילים: כותב\nלחן: מלחין\n\n\n\n'
            ' שורה ראשונה\nשורה שנייה'
        )
        self.assertEqual(clean_lyrics(text), 'שורה ראשונה\nשורה שנייה')

    def test_combined_credit_labels(self):
        self.assertEqual(clean_lyrics('שיר\nמילים ולחן: שלמה ארצי\nשורה'), 'שורה')
        self.assertEqual(clean_lyrics('שיר\nלחן, עיבוד: מישהו\nשורה'), 'שורה')
        self.assertEqual(clean_lyrics('Song\nArrangement: Someone\nLine'), 'Line')
        self.assertEqual(clean_lyrics('heb||שיר\nביצוע: להקה\nשורה'), 'שורה')

    def test_spoken_lines_with_a_colon_are_kept(self):
        text = 'הוא אמר:\nבוא נלך\nפזמון:\nלה לה'
        self.assertEqual(clean_lyrics(text), text)

    def test_credit_label_far_down_is_kept(self):
        text = '\n'.join(f'שורה {number}' for number in range(10)) + '\nמילים: אלה מילים'
        self.assertEqual(clean_lyrics(text), text)

    def test_instrumental_placeholder_is_empty(self):
        self.assertEqual(clean_lyrics('instrumental'), '')
        self.assertEqual(clean_lyrics('heb||[Instrumental]'), '')
        self.assertEqual(clean_lyrics('heb||אינסטרומנטלי\n(ופתיחה לאלבום)'), '')

    def test_lyrics_mentioning_instrumental_are_kept(self):
        text = 'Instrumental break\nThen we sing\nAnd sing\nAnd sing again'
        self.assertEqual(clean_lyrics(text), text)
        self.assertEqual(clean_lyrics('An instrumental song'), 'An instrumental song')


class LrcToPlainTest(unittest.TestCase):
    def test_time_tags_and_headers_are_removed(self):
        text = '[ar:Artist]\r\n[ti:Title]\r\n[00:01.00]First line\r\n[00:05.50] Second line\r\n[01:02:03]שורה שלישית'
        self.assertEqual(lrc_to_plain(text), 'First line\nSecond line\nשורה שלישית')

    def test_repeated_lines_keep_one_copy_in_file_order(self):
        self.assertEqual(lrc_to_plain('[00:10.00][01:10.00]Chorus\n[00:20.00]Verse'), 'Chorus\nVerse')

    def test_word_time_tags_are_removed(self):
        self.assertEqual(lrc_to_plain('[00:01.00]<00:01.00>One <00:01.50>two'), 'One two')

    def test_gaps_become_one_blank_line(self):
        text = '[00:00.00]\n[00:01.00]A\n[00:02.00]\n[00:03.00]\n[00:04.00]B\n[00:05.00]'
        self.assertEqual(lrc_to_plain(text), 'A\n\nB')

    def test_brackets_that_are_not_time_tags_stay(self):
        self.assertEqual(lrc_to_plain('[00:01.00][Chorus]\n[00:02.00]La'), '[Chorus]\nLa')


if __name__ == '__main__':
    unittest.main()
