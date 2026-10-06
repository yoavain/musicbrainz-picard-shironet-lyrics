import os
import sqlite3
import tempfile
import unittest

import _support

_support.load_plugin_package()

from shironet_lyrics.src.lyrics_cache import (  # noqa: E402
    SCHEMA_VERSION,
    SOURCE_EMBEDDED,
    LyricsCache,
    PutResult,
    ScannedFile,
    clean_lyrics,
    embedded_lyrics,
    has_hebrew,
    is_hebrew_song,
    normalize,
    normalize_path,
)


class FakeMetadata:
    """The part of Picard's Metadata that embedded_lyrics() uses."""

    def __init__(self, tags):
        self._tags = {name: value if isinstance(value, list) else [value] for name, value in tags.items()}

    def keys(self):
        return self._tags.keys()

    def getall(self, name):
        return self._tags.get(name, [])


class NormalizeTest(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(normalize(None), '')
        self.assertEqual(normalize('  '), '')

    def test_latin_case_and_punctuation(self):
        self.assertEqual(normalize("Don't Stop Me Now!"), 'dont stop me now')
        self.assertEqual(normalize('Beyoncé'), 'beyonce')

    def test_hebrew_niqqud_is_dropped(self):
        self.assertEqual(normalize('שִׁיר לַשָּׁלוֹם'), 'שיר לשלום')

    def test_hebrew_geresh_gershayim_and_quotes(self):
        self.assertEqual(normalize('ג׳ינס'), normalize("ג'ינס"))
        self.assertEqual(normalize('להקת הנח״ל'), normalize('להקת הנח"ל'))
        self.assertEqual(normalize('להקת הנח"ל'), 'להקת הנחל')

    def test_maqaf_and_dash_separate_words(self):
        self.assertEqual(normalize('בית־לחם'), 'בית לחם')
        self.assertEqual(normalize('בית-לחם'), 'בית לחם')

    def test_featuring_is_dropped(self):
        self.assertEqual(normalize('Song (feat. Someone)'), 'song')
        self.assertEqual(normalize('Artist ft. Other'), 'artist')
        self.assertEqual(normalize('Artist featuring Other'), 'artist')

    def test_featuring_needs_a_whole_word(self):
        self.assertEqual(normalize('Gift'), 'gift')
        self.assertEqual(normalize('Feather'), 'feather')

    def test_version_suffixes_are_dropped(self):
        self.assertEqual(normalize('Song (Live)'), 'song')
        self.assertEqual(normalize('Song [Remastered 2011]'), 'song')
        self.assertEqual(normalize('Song - Remastered 2011'), 'song')
        self.assertEqual(normalize('Song (Live) [Remastered]'), 'song')
        self.assertEqual(normalize('שיר לשלום (בהופעה חיה)'), 'שיר לשלום')
        self.assertEqual(normalize('שיר לשלום - גרסה אקוסטית'), 'שיר לשלום')

    def test_other_brackets_are_kept(self):
        self.assertEqual(normalize('שיר (בלי שם)'), 'שיר בלי שם')
        self.assertEqual(normalize('Live and Let Die'), 'live and let die')


class HebrewTest(unittest.TestCase):
    def test_has_hebrew(self):
        self.assertTrue(has_hebrew('שיר לשלום'))
        self.assertTrue(has_hebrew('Love שיר'))
        self.assertFalse(has_hebrew('Love Song'))
        self.assertFalse(has_hebrew(None))

    def test_niqqud_or_punctuation_alone_is_not_hebrew(self):
        self.assertFalse(has_hebrew(chr(0x05B8) + chr(0x05BE) + chr(0x05F3)))  # qamats, maqaf, geresh

    def test_presentation_forms_are_hebrew(self):
        self.assertTrue(has_hebrew(chr(0xFB2A)))  # shin with shin dot

    def test_song_with_hebrew_title_or_artist(self):
        self.assertTrue(is_hebrew_song('Mashina', 'את לא כמו כולם'))
        self.assertTrue(is_hebrew_song('משינה', 'Rakevet Layla'))
        self.assertFalse(is_hebrew_song('R.E.M.', 'The One I Love'))

    def test_song_with_hebrew_language_tag(self):
        self.assertTrue(is_hebrew_song('Mashina', 'Rakevet', language='heb'))
        self.assertTrue(is_hebrew_song('Mashina', 'Rakevet', language=' HE '))
        self.assertFalse(is_hebrew_song('Mashina', 'Rakevet', language='eng'))

    def test_song_with_mostly_hebrew_lyrics(self):
        self.assertTrue(is_hebrew_song('Mashina', 'Rakevet', lyrics='שורה ארוכה בעברית' + chr(10) + 'Oh yeah'))
        self.assertFalse(is_hebrew_song('Band', 'Song', lyrics='An English song' + chr(10) + 'שלום'))


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


class EmbeddedLyricsTest(unittest.TestCase):
    def test_plain_lyrics_tag(self):
        self.assertEqual(embedded_lyrics(FakeMetadata({'lyrics': 'a\r\nb'})), 'a\nb')

    def test_plain_wins_over_described(self):
        metadata = FakeMetadata({'lyrics:eng': 'described', 'lyrics': 'plain'})
        self.assertEqual(embedded_lyrics(metadata), 'plain')

    def test_described_when_no_plain(self):
        metadata = FakeMetadata({'lyrics': ' ', 'lyrics:b': 'second', 'lyrics:a': 'first'})
        self.assertEqual(embedded_lyrics(metadata), 'first')

    def test_multiple_values_are_not_joined(self):
        self.assertEqual(embedded_lyrics(FakeMetadata({'lyrics': ['one', 'two']})), 'one')

    def test_synced_lyrics_are_ignored(self):
        self.assertEqual(embedded_lyrics(FakeMetadata({'syncedlyrics': '[00:01.00]x', 'title': 't'})), '')


class LyricsCacheTest(unittest.TestCase):
    def setUp(self):
        self.cache = LyricsCache(':memory:')

    def tearDown(self):
        self.cache.close()

    def test_add_and_get(self):
        result = self.cache.put('להקת הנח"ל', 'שיר לשלום', 'שורה ראשונה', SOURCE_EMBEDDED, '/a.mp3')
        self.assertIs(result, PutResult.ADDED)
        entry = self.cache.get('להקת הנח״ל', 'שִׁיר לַשָּׁלוֹם (Live)')
        self.assertIsNotNone(entry)
        self.assertEqual(entry.artist, 'להקת הנח"ל')
        self.assertEqual(entry.lyrics, 'שורה ראשונה')
        self.assertEqual(entry.source, SOURCE_EMBEDDED)
        self.assertEqual(entry.source_ref, '/a.mp3')

    def test_get_missing(self):
        self.assertIsNone(self.cache.get('a', 'b'))
        self.assertIsNone(self.cache.get('', 'b'))

    def test_same_lyrics_is_unchanged(self):
        self.cache.put('A', 'T', 'text', SOURCE_EMBEDDED)
        self.assertIs(self.cache.put('a', 't', 'text \r\n', SOURCE_EMBEDDED), PutResult.UNCHANGED)
        self.assertEqual(self.cache.count(), 1)

    def test_different_lyrics_is_a_conflict_and_keeps_the_first(self):
        self.cache.put('A', 'T', 'first', SOURCE_EMBEDDED)
        self.assertIs(self.cache.put('A', 'T', 'second', SOURCE_EMBEDDED), PutResult.CONFLICT)
        self.assertEqual(self.cache.get('A', 'T').lyrics, 'first')

    def test_replace(self):
        self.cache.put('A', 'T', 'first', SOURCE_EMBEDDED)
        self.assertIs(self.cache.put('A', 'T', 'second', 'paste', replace=True), PutResult.REPLACED)
        entry = self.cache.get('A', 'T')
        self.assertEqual((entry.lyrics, entry.source), ('second', 'paste'))

    def test_skipped_when_a_part_is_empty(self):
        self.assertIs(self.cache.put('', 'T', 'x', SOURCE_EMBEDDED), PutResult.SKIPPED)
        self.assertIs(self.cache.put('A', None, 'x', SOURCE_EMBEDDED), PutResult.SKIPPED)
        self.assertIs(self.cache.put('A', 'T', ' \n', SOURCE_EMBEDDED), PutResult.SKIPPED)
        self.assertIs(self.cache.put('!!!', 'T', 'x', SOURCE_EMBEDDED), PutResult.SKIPPED)
        self.assertEqual(self.cache.count(), 0)

    def test_lookup_returns_the_first_cached_name(self):
        self.cache.put('Shlomo Artzi', 'Havtachot', 'from latin tags', SOURCE_EMBEDDED)
        self.cache.put('שלמה ארצי', 'הבטחות', 'from hebrew tags', SOURCE_EMBEDDED)
        both = [('שלמה ארצי', 'הבטחות (Live)'), ('Shlomo Artzi', 'Havtachot')]
        self.assertEqual(self.cache.lookup(both).lyrics, 'from hebrew tags')
        self.assertEqual(self.cache.lookup(both[::-1]).lyrics, 'from latin tags')

    def test_lookup_falls_back_to_later_names(self):
        self.cache.put('Shlomo Artzi', 'Havtachot', 'text', SOURCE_EMBEDDED)
        names = [('שלמה ארצי', 'הבטחות'), (None, None), ('Shlomo Artzi', 'Havtachot')]
        self.assertEqual(self.cache.lookup(names).lyrics, 'text')

    def test_lookup_miss(self):
        self.assertIsNone(self.cache.lookup([('A', 'T'), ('', '')]))
        self.assertIsNone(self.cache.lookup([]))

    def test_same_source_replaces_its_own_entry(self):
        self.cache.put('A', 'T', 'old', SOURCE_EMBEDDED, '/a.mp3')
        self.assertIs(self.cache.put('A', 'T', 'new', SOURCE_EMBEDDED, '/a.mp3'), PutResult.REPLACED)
        self.assertEqual(self.cache.get('A', 'T').lyrics, 'new')

    def test_other_source_does_not_replace(self):
        self.cache.put('A', 'T', 'old', SOURCE_EMBEDDED, '/a.mp3')
        self.assertIs(self.cache.put('A', 'T', 'new', SOURCE_EMBEDDED, '/b.mp3'), PutResult.CONFLICT)
        self.assertIs(self.cache.put('A', 'T', 'new', SOURCE_EMBEDDED, None), PutResult.CONFLICT)

    def test_put_file_lyrics_stores_each_distinct_name_once(self):
        names = [('Artist', 'Song'), ('artist', 'song (Live)'), ('Other', 'Song')]
        results = self.cache.put_file_lyrics(names, 'text', 'a.mp3')
        self.assertEqual(results, [PutResult.ADDED, PutResult.ADDED])
        self.assertEqual(self.cache.get('Other', 'Song').source_ref, normalize_path('a.mp3'))

    def test_scanned_files(self):
        self.assertFalse(self.cache.is_scanned('a.mp3', 100, 10))
        self.cache.mark_scanned('a.mp3', 100, 10, 'A', 'T', False)
        self.assertTrue(self.cache.is_scanned('a.mp3', 100, 10))
        self.assertTrue(self.cache.is_scanned(os.path.abspath('a.mp3'), 100, 10))
        self.assertFalse(self.cache.is_scanned('a.mp3', 101, 10))
        self.assertFalse(self.cache.is_scanned('a.mp3', 100, 11))
        self.assertEqual(self.cache.scanned_file('a.mp3', 100, 10), ScannedFile('A', 'T', False))

    def test_file_read_before_schema_6_needs_another_read(self):
        # Records without has_lyrics come from older scans: they do not say whether to queue the song.
        self.cache.mark_scanned('a.mp3', 100, 10)
        self.assertIsNone(self.cache.scanned_file('a.mp3', 100, 10))

    def test_batch_rolls_back_on_error(self):
        with self.assertRaises(ValueError):
            with self.cache.batch():
                self.cache.put('A', 'T', 'x', SOURCE_EMBEDDED)
                raise ValueError
        self.assertEqual(self.cache.count(), 0)

    def test_batch_commits(self):
        with self.cache.batch():
            self.cache.put('A', 'T1', 'x', SOURCE_EMBEDDED)
            with self.cache.batch():
                self.cache.put('A', 'T2', 'y', SOURCE_EMBEDDED)
        self.assertEqual(self.cache.count(), 2)


class LyricsCacheFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, 'lyrics.sqlite3')

    def tearDown(self):
        self.tmp.cleanup()

    def test_data_survives_reopen(self):
        cache = LyricsCache(self.path)
        with cache.batch():
            cache.put('A', 'T', 'text', SOURCE_EMBEDDED)
        cache.close()
        cache = LyricsCache(self.path)
        self.assertEqual(cache.get('A', 'T').lyrics, 'text')
        cache.close()

    def test_version_1_database_is_upgraded(self):
        conn = sqlite3.connect(self.path)
        conn.executescript(
            "CREATE TABLE lyrics (artist_key TEXT NOT NULL, title_key TEXT NOT NULL, artist TEXT NOT NULL,"
            " title TEXT NOT NULL, lyrics TEXT NOT NULL, source TEXT NOT NULL, source_ref TEXT,"
            " updated_at TEXT NOT NULL, PRIMARY KEY (artist_key, title_key)) WITHOUT ROWID;"
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
            "INSERT INTO meta VALUES ('schema_version', '1');"
            "INSERT INTO lyrics VALUES ('a', 't', 'A', 'T', 'kept', 'embedded', NULL, 'x');"
        )
        conn.commit()
        conn.close()
        cache = LyricsCache(self.path)
        self.assertEqual(cache.get('A', 'T').lyrics, 'kept')
        cache.mark_scanned('x.mp3', 1, 2)
        cache.close()
        conn = sqlite3.connect(self.path)
        version = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()[0]
        conn.close()
        self.assertEqual(version, str(SCHEMA_VERSION))

    def test_version_5_misses_get_a_retry_time(self):
        LyricsCache(self.path).close()
        conn = sqlite3.connect(self.path)
        conn.executemany(
            "INSERT INTO shironet_queue (artist_key, title_key, artist, title, purpose, status, added_at, updated_at) "
            "VALUES (?, ?, ?, ?, 'fetch', ?, 'x', ?)",
            [
                ('a', 'miss', 'A', 'Miss', 'not_found', '2026-10-06T10:00:00+00:00'),
                ('a', 'fail', 'A', 'Fail', 'failed', '2026-10-06T11:00:00+00:00'),
                ('a', 'wait', 'A', 'Wait', 'pending', '2026-10-06T12:00:00+00:00'),
            ],
        )
        conn.execute("UPDATE meta SET value = '5' WHERE key = 'schema_version'")
        conn.commit()
        conn.close()

        LyricsCache(self.path).close()

        conn = sqlite3.connect(self.path)
        rows = dict(conn.execute('SELECT title, retry_after FROM shironet_queue').fetchall())
        conn.close()
        self.assertEqual(rows, {
            'Miss': '2026-10-13T10:00:00+00:00',  # a week
            'Fail': '2026-10-07T11:00:00+00:00',  # a day
            'Wait': None,
        })

    def test_version_4_queue_gets_the_alternate_columns(self):
        conn = sqlite3.connect(self.path)
        conn.executescript(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
            "INSERT INTO meta VALUES ('schema_version', '4');"
            "CREATE TABLE shironet_queue (artist_key TEXT NOT NULL, title_key TEXT NOT NULL,"
            " artist TEXT NOT NULL, title TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL,"
            " attempts INTEGER NOT NULL DEFAULT 0, lyrics_url TEXT, result TEXT, added_at TEXT NOT NULL,"
            " updated_at TEXT NOT NULL, PRIMARY KEY (artist_key, title_key)) WITHOUT ROWID;"
            "INSERT INTO shironet_queue VALUES ('a', 't', 'A', 'T', 'fetch', 'pending', 0, NULL, NULL, 'x', 'x');"
        )
        conn.commit()
        conn.close()
        LyricsCache(self.path).close()
        conn = sqlite3.connect(self.path)
        columns = [row[1] for row in conn.execute('PRAGMA table_info(shironet_queue)')]
        kept = conn.execute('SELECT artist, alt_artist FROM shironet_queue').fetchall()
        conn.close()
        self.assertIn('alt_artist', columns)
        self.assertIn('alt_title', columns)
        self.assertEqual(kept, [('A', None)])

    def test_version_2_database_is_cleaned(self):
        cache = LyricsCache(self.path)
        cache.close()
        conn = sqlite3.connect(self.path)
        conn.executemany(
            "INSERT INTO lyrics VALUES (?, ?, ?, ?, ?, 'embedded', NULL, 'x')",
            [
                ('a', 'prefixed', 'A', 'Prefixed', 'heb||text'),
                ('a', 'credits', 'A', 'Credits', 'Credits\nמילים: מישהו\n\ntext'),
                ('a', 'instrumental', 'A', 'Instrumental', '[instrumental]'),
                ('a', 'clean', 'A', 'Clean', 'already clean'),
            ],
        )
        conn.execute("UPDATE meta SET value = '2' WHERE key = 'schema_version'")
        conn.commit()
        conn.close()

        cache = LyricsCache(self.path)

        self.assertEqual(cache.cleanup_counts, (2, 1))
        self.assertEqual(cache.get('A', 'Prefixed').lyrics, 'text')
        self.assertEqual(cache.get('A', 'Credits').lyrics, 'text')
        self.assertIsNone(cache.get('A', 'Instrumental'))
        self.assertEqual(cache.get('A', 'Clean').lyrics, 'already clean')
        cache.close()
        cache = LyricsCache(self.path)
        self.assertIsNone(cache.cleanup_counts)  # runs once
        cache.close()

    def test_new_database_runs_no_cleanup(self):
        cache = LyricsCache(self.path)
        self.assertIsNone(cache.cleanup_counts)
        cache.close()

    def test_newer_schema_is_refused(self):
        LyricsCache(self.path).close()
        conn = sqlite3.connect(self.path)
        conn.execute("UPDATE meta SET value = ? WHERE key = 'schema_version'", (str(SCHEMA_VERSION + 1),))
        conn.commit()
        conn.close()
        with self.assertRaises(RuntimeError):
            LyricsCache(self.path)


if __name__ == '__main__':
    unittest.main()
