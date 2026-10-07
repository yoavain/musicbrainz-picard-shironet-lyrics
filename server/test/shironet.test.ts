import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_URL, artistSearchUrl, interpretArtistSearch, interpretLyrics, interpretSearch, interpretWorks, isChallengeUrl,
  isLyricsUrl, nextPageUrl, pickArtist, pickResult, searchQuery, searchUrl, workId, worksUrl,
} from '../src/shironet.ts';
import type { ExtractedPage, SearchResult } from '../src/shironet.ts';

function page(partial: Partial<ExtractedPage>): ExtractedPage {
  return { url: `${BASE_URL}/x`, title: '', challenge: false, links: [], lyrics: null, ...partial };
}

const RESULTS: SearchResult[] = [
  { title: 'שיר לשלום', artist: 'להקת הנח"ל', url: `${BASE_URL}/artist?type=lyrics&lang=1&prfid=578&wrkid=3005` },
  { title: 'שיר לשלום', artist: 'עופרה חזה', url: `${BASE_URL}/artist?type=lyrics&lang=1&prfid=820&wrkid=3005` },
];

describe('URLs', () => {
  test('search URL percent-encodes UTF-8, space as %20', () => {
    assert.equal(
      searchUrl(' שיר לשלום '),
      `${BASE_URL}/searchSongs?q=%D7%A9%D7%99%D7%A8%20%D7%9C%D7%A9%D7%9C%D7%95%D7%9D&type=lyrics`,
    );
  });
  test('plus and ampersand are encoded', () => {
    assert.equal(searchUrl('1+1 & 2'), `${BASE_URL}/searchSongs?q=1%2B1%20%26%202&type=lyrics`);
  });
  test('searchQuery drops angle brackets and control characters', () => {
    assert.equal(searchQuery('<title> שיר\u0007 '), 'title שיר');
  });
  test('lyrics URL and work id', () => {
    const url = `${BASE_URL}/artist?type=lyrics&lang=1&prfid=578&wrkid=3005`;
    assert.equal(isLyricsUrl(url), true);
    assert.equal(workId(url), '3005');
    assert.equal(isLyricsUrl(`${BASE_URL}/artist?lang=1&prfid=578`), false);
    assert.equal(isLyricsUrl('https://example.com/artist?type=lyrics&wrkid=3005'), false);
    assert.equal(isLyricsUrl(`${BASE_URL}/artist?type=lyrics&wrkid=`), false);
    assert.equal(isLyricsUrl('not a url'), false);
    assert.equal(workId(`${BASE_URL}/artist?prfid=578`), null);
  });
  test('a look-alike host is not Shironet', () => {
    assert.equal(isLyricsUrl('https://evilshironet.mako.co.il/artist?type=lyrics&wrkid=1'), false);
    assert.equal(isLyricsUrl('https://www.shironet.mako.co.il/artist?type=lyrics&wrkid=1'), true);
  });
  test('challenge URL', () => {
    assert.equal(isChallengeUrl('https://validate.perfdrive.com/?ssa=1'), true);
    assert.equal(isChallengeUrl('https://perfdrive.com/'), true);
    assert.equal(isChallengeUrl(`${BASE_URL}/x`), false);
    assert.equal(isChallengeUrl(null), false);
  });
});

describe('interpretSearch', () => {
  test('pairs song and artist links and keeps lyrics URLs only', () => {
    const results = interpretSearch(page({
      links: [
        { text: ' שיר  לשלום', href: '/artist?type=lyrics&lang=1&prfid=578&wrkid=3005' },
        { text: ' להקת הנח"ל', href: '/artist?lang=1&prfid=578' },
        { text: ' שיר לשלום', href: '/artist?type=lyrics&lang=1&prfid=820&wrkid=3005' },
        { text: ' עופרה חזה', href: '/artist?lang=1&prfid=820' },
        { text: 'not a song', href: '/artist?lang=1&prfid=1' },
        { text: 'anyone', href: '/artist?lang=1&prfid=2' },
      ],
    }));
    assert.deepEqual(results, RESULTS);
  });
  test('an empty page has no results', () => {
    assert.deepEqual(interpretSearch(page({})), []);
  });
  test('a malformed link is skipped; the other results count', () => {
    const results = interpretSearch(page({
      links: [
        { text: 'bad', href: 'http://[::1' },
        { text: 'artist', href: '/artist?lang=1&prfid=1' },
        { text: ' שיר לשלום', href: '/artist?type=lyrics&lang=1&prfid=820&wrkid=3005' },
        { text: ' עופרה חזה', href: '/artist?lang=1&prfid=820' },
      ],
    }));
    assert.deepEqual(results.map((r) => r.artist), ['עופרה חזה']);
  });
  test('a link without href is skipped', () => {
    assert.deepEqual(interpretSearch(page({ links: [{ text: 'x', href: null }, { text: 'y', href: null }] })), []);
  });
});

describe('nextPageUrl', () => {
  test('resolves the next-page link against the search page', () => {
    const p = page({ url: `${BASE_URL}/searchSongs?q=x&type=lyrics`, nextPageHref: '?q=x&type=lyrics&page=2' });
    assert.equal(nextPageUrl(p), `${BASE_URL}/searchSongs?q=x&type=lyrics&page=2`);
  });
  test('a link with page twice (Shironet, from page 2 on) goes to the last page value', () => {
    // Live page 2 of a search, 2026-10-07: following this href as written loads page 2 again.
    const p = page({
      url: `${BASE_URL}/searchSongs?q=x&type=lyrics&page=2`,
      nextPageHref: '?page=2&q=x&type=lyrics&page=3',
    });
    assert.equal(nextPageUrl(p), `${BASE_URL}/searchSongs?q=x&type=lyrics&page=3`);
  });
  test('a next link that leads back to the same page gives null (no loop)', () => {
    const p = page({ url: `${BASE_URL}/searchSongs?q=x&type=lyrics&page=2`, nextPageHref: '?q=x&type=lyrics&page=2' });
    assert.equal(nextPageUrl(p), null);
  });
  test('no link, a link off Shironet, or a malformed link gives null', () => {
    assert.equal(nextPageUrl(page({})), null);
    assert.equal(nextPageUrl(page({ nextPageHref: null })), null);
    assert.equal(nextPageUrl(page({ nextPageHref: 'https://evil.example/searchSongs?page=2' })), null);
    assert.equal(nextPageUrl(page({ nextPageHref: 'http://[::1' })), null);
  });
});

describe('pickResult', () => {
  test('exact artist', () => {
    assert.equal(pickResult(RESULTS, 'עופרה חזה', 'שיר לשלום')?.artist, 'עופרה חזה');
  });
  test('partial artist', () => {
    assert.equal(pickResult(RESULTS, 'הנח"ל', 'שיר לשלום')?.artist, 'להקת הנח"ל');
  });
  test('needs the title and an artist', () => {
    assert.equal(pickResult(RESULTS, 'עופרה חזה', 'שיר אחר'), null);
    assert.equal(pickResult(RESULTS, 'אמן אחר', 'שיר לשלום'), null);
    assert.equal(pickResult(RESULTS, '', 'שיר לשלום'), null);
  });
  test('gershayim and quotes match', () => {
    assert.equal(pickResult(RESULTS, 'להקת הנח״ל', 'שיר לשלום')?.artist, 'להקת הנח"ל');
  });
});

describe('interpretLyrics', () => {
  test('a lyrics page', () => {
    const result = interpretLyrics(page({
      lyrics: { song: ' שיר לשלום ', singer: 'להקת הנח"ל', text: 'שורה ראשונה \nשורה  שנייה "בגרשיים"\n \nבית שני' },
    }));
    assert.deepEqual(result, { title: 'שיר לשלום', artist: 'להקת הנח"ל', lyrics: 'שורה ראשונה\nשורה שנייה "בגרשיים"\n\nבית שני' });
  });
  test('credits are cleaned', () => {
    const result = interpretLyrics(page({
      lyrics: { song: 'שיר', singer: 'זמר', text: 'מילים: מישהו\nלחן: מישהו\n\nשורה\nשורה שנייה' },
    }));
    assert.equal(result?.lyrics, 'שורה\nשורה שנייה');
  });
  test('no lyrics element, or only a placeholder, gives null', () => {
    assert.equal(interpretLyrics(page({})), null);
    assert.equal(interpretLyrics(page({ lyrics: { song: 'שיר', singer: 'זמר', text: 'instrumental' } })), null);
  });
});

function artistPage(links: Array<[string, string | null]>, nextPageHref: string | null = null): ExtractedPage {
  return {
    url: `${BASE_URL}/searchArtists?q=x`, title: '', challenge: false, lyrics: null, nextPageHref,
    links: links.map(([text, href]) => ({ text, href })),
  };
}
function worksPage(works: Array<[string, string | null]>): ExtractedPage {
  return {
    url: worksUrl(41), title: '', challenge: false, lyrics: null, links: [],
    works: works.map(([text, href]) => ({ text, href })),
  };
}

describe('artist route', () => {
  test('URLs', () => {
    assert.equal(artistSearchUrl('אביתר בנאי'), `${BASE_URL}/searchArtists?q=%D7%90%D7%91%D7%99%D7%AA%D7%A8%20%D7%91%D7%A0%D7%90%D7%99`);
    assert.equal(artistSearchUrl('<b>להקה</b>'), artistSearchUrl(' b להקה /b '));
    assert.equal(worksUrl(41), `${BASE_URL}/artist?type=works&lang=1&prfid=41`);
  });
  test('interpretArtistSearch: artist links with their prfid, page order', () => {
    const page = artistPage([
      ['אביתר בנאי', '/artist?lang=1&prfid=41'],
      ['אביתר בנאי ומאיר בנאי', '/artist?lang=1&prfid=3126'],
      ['broken', null],
      ['no id', '/artist?lang=1'],
      ['other site', 'https://example.com/artist?prfid=9'],
    ]);
    assert.deepEqual(interpretArtistSearch(page), [
      { name: 'אביתר בנאי', prfid: 41 },
      { name: 'אביתר בנאי ומאיר בנאי', prfid: 3126 },
    ]);
  });
  test('pickArtist: exact after normalization only; a duet is not the artist', () => {
    const artists = [{ name: 'אביתר בנאי ומאיר בנאי', prfid: 3126 }, { name: 'אביתר  בנאי', prfid: 41 }];
    assert.deepEqual(pickArtist(artists, 'אביתר בנאי'), { name: 'אביתר  בנאי', prfid: 41 });
    assert.equal(pickArtist(artists, 'בנאי'), null);
    assert.equal(pickArtist(artists, ''), null);
  });
  test('interpretWorks: song titles with absolute lyrics URLs; other links dropped', () => {
    const page = worksPage([
      ['\tאב הרחמן', '/artist?type=lyrics&lang=1&prfid=41&wrkid=23571'],
      ['בשבילך', '/artist?type=lyrics&lang=1&prfid=41&wrkid=14352'],
      ['chords', '/artist?type=chords&lang=1&prfid=41&wrkid=12'],
      ['broken', null],
    ]);
    assert.deepEqual(interpretWorks(page), [
      { title: 'אב הרחמן', url: `${BASE_URL}/artist?type=lyrics&lang=1&prfid=41&wrkid=23571` },
      { title: 'בשבילך', url: `${BASE_URL}/artist?type=lyrics&lang=1&prfid=41&wrkid=14352` },
    ]);
    assert.deepEqual(interpretWorks({ ...page, works: undefined }), []);
  });
  test('works pages: the next link is followed like the search pages', () => {
    const page = { ...worksPage([]), nextPageHref: '/artist?lang=1&prfid=41&type=works&page=2' };
    assert.equal(nextPageUrl(page), `${BASE_URL}/artist?lang=1&prfid=41&type=works&page=2`);
  });
});
