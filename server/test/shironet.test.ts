import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_URL, interpretLyrics, interpretSearch, isChallengeUrl, isLyricsUrl, pickResult, searchQuery,
  searchUrl, workId,
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
