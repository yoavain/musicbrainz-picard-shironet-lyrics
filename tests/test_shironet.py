import os
import unittest

import _support

_support.load_plugin_package()

from shironet_lyrics.src.shironet import (  # noqa: E402
    SearchResult,
    is_challenge,
    is_lyrics_url,
    parse_lyrics_page,
    parse_search,
    pick_result,
    search_url,
    work_id,
)


FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding='utf-8', errors='replace') as f:
        return f.read()


class UrlTest(unittest.TestCase):
    def test_search_url(self):
        self.assertEqual(
            search_url(' שיר לשלום '),
            'https://shironet.mako.co.il/searchSongs?q=%D7%A9%D7%99%D7%A8+%D7%9C%D7%A9%D7%9C%D7%95%D7%9D&type=lyrics',
        )

    def test_lyrics_url(self):
        url = 'https://shironet.mako.co.il/artist?type=lyrics&lang=1&prfid=578&wrkid=3005'
        self.assertTrue(is_lyrics_url(url))
        self.assertEqual(work_id(url), '3005')
        self.assertFalse(is_lyrics_url('https://shironet.mako.co.il/artist?lang=1&prfid=578'))
        self.assertFalse(is_lyrics_url('https://example.com/artist?type=lyrics&wrkid=3005'))
        self.assertIsNone(work_id('https://shironet.mako.co.il/artist?prfid=578'))

    def test_challenge(self):
        self.assertTrue(is_challenge('https://validate.perfdrive.com/?ssa=1'))
        self.assertTrue(is_challenge(None, fixture('shironet_challenge.html')))
        self.assertFalse(is_challenge('https://shironet.mako.co.il/x', fixture('shironet_search.html')))
        self.assertFalse(is_challenge(None, fixture('shironet_lyrics.html')))
        self.assertFalse(is_challenge(None, None))


class ParseSearchTest(unittest.TestCase):
    def setUp(self):
        self.results = parse_search(fixture('shironet_search.html'))

    def test_pairs_of_song_and_artist(self):
        self.assertEqual(len(self.results), 10)
        self.assertEqual(
            self.results[0],
            SearchResult('שיר לשלום', 'להקת הנח"ל',
                         'https://shironet.mako.co.il/artist?type=lyrics&lang=1&prfid=578&wrkid=3005'),
        )
        self.assertEqual(self.results[1].artist, 'עופרה חזה')
        self.assertTrue(all(work_id(result.url) == '3005' for result in self.results))

    def test_empty_page(self):
        self.assertEqual(parse_search('<html><body>no results</body></html>'), [])

    def test_pick_exact_artist(self):
        self.assertEqual(pick_result(self.results, 'עופרה חזה', 'שיר לשלום').artist, 'עופרה חזה')

    def test_pick_partial_artist(self):
        self.assertEqual(pick_result(self.results, 'הנח"ל', 'שיר לשלום').artist, 'להקת הנח"ל')

    def test_pick_needs_the_title(self):
        self.assertIsNone(pick_result(self.results, 'עופרה חזה', 'שיר אחר'))
        self.assertIsNone(pick_result(self.results, 'אמן אחר', 'שיר לשלום'))
        self.assertIsNone(pick_result(self.results, '', 'שיר לשלום'))


class ParseLyricsPageTest(unittest.TestCase):
    def test_lyrics_page(self):
        page = parse_lyrics_page(fixture('shironet_lyrics.html'))
        self.assertEqual(page.title, 'שיר לשלום')
        self.assertEqual(page.artist, 'להקת הנח"ל')
        # Only <br> breaks lines; entities are decoded; one blank line between stanzas.
        self.assertEqual(
            page.lyrics,
            'שורה ראשונה\nשורה שנייה "בגרשיים"\n\nבית שני, שורה ראשונה\nבית שני, שורה שנייה',
        )

    def test_page_without_lyrics(self):
        self.assertIsNone(parse_lyrics_page(fixture('shironet_search.html')))
        self.assertIsNone(parse_lyrics_page(fixture('shironet_challenge.html')))

    def test_minimal_page_with_credits(self):
        html = (
            '<h1 class="artist_song_name_txt">שיר</h1><a class="artist_singer_title" href="/x">זמר</a>'
            '<span class="artist_lyrics_text">מילים: מישהו<br>לחן: מישהו<br><br>שורה<br>שורה שנייה</span>'
        )
        page = parse_lyrics_page(html)
        self.assertEqual((page.title, page.artist, page.lyrics), ('שיר', 'זמר', 'שורה\nשורה שנייה'))


if __name__ == '__main__':
    unittest.main()
