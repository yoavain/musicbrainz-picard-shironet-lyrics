import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, processSong } from '../src/fetcher.ts';
import type { RequestKind, RequestResult } from '../src/fetcher.ts';
import { BASE_URL, artistSearchUrl, searchUrl, worksUrl } from '../src/shironet.ts';
import { getArtist, saveArtistSearch, saveWorks } from '../src/artists.ts';
import type { ExtractedPage } from '../src/shironet.ts';
import { SOURCE_EMBEDDED, Store } from '../src/store.ts';
import * as queue from '../src/queue.ts';

const NOW = new Date(Date.UTC(2026, 9, 7, 12));
const LYRICS_URL = `${BASE_URL}/artist?type=lyrics&lang=1&prfid=578&wrkid=3005`;

function searchPage(pairs: Array<[string, string, string]>, nextPageHref: string | null = null): RequestResult {
  const links = pairs.flatMap(([title, artist, href]) => [{ text: title, href }, { text: artist, href: '/artist?lang=1&prfid=1' }]);
  return { outcome: 'ok', page: { url: `${BASE_URL}/searchSongs`, title: '', challenge: false, links, lyrics: null, nextPageHref } };
}
function lyricsPage(text: string): RequestResult {
  const page: ExtractedPage = { url: LYRICS_URL, title: '', challenge: false, links: [], lyrics: { song: 'שיר לשלום', singer: 'להקת הנח"ל', text } };
  return { outcome: 'ok', page };
}

function artistResults(artists: Array<[string, number]>, nextPageHref: string | null = null): RequestResult {
  const links = artists.map(([name, prfid]) => ({ text: name, href: `/artist?lang=1&prfid=${prfid}` }));
  return { outcome: 'ok', page: { url: `${BASE_URL}/searchArtists`, title: '', challenge: false, links, lyrics: null, nextPageHref } };
}
function worksResult(prfid: number, titles: Array<[string, number]>, nextPageHref: string | null = null): RequestResult {
  const works = titles.map(([title, wrkid]) => ({ text: title, href: `/artist?type=lyrics&lang=1&prfid=${prfid}&wrkid=${wrkid}` }));
  return { outcome: 'ok', page: { url: worksUrl(prfid), title: '', challenge: false, links: [], lyrics: null, works, nextPageHref } };
}
function resultOf(store: Store, title: string): string {
  return String((store.db.prepare('SELECT result FROM queue WHERE title = ?').get(title) as { result: string }).result);
}
const workUrl = (prfid: number, wrkid: number) => `${BASE_URL}/artist?type=lyrics&lang=1&prfid=${prfid}&wrkid=${wrkid}`;

/** A scripted requester: answers by URL, records every call. */
function script(answers: Record<string, RequestResult | RequestResult[]>) {
  const calls: Array<[RequestKind, string]> = [];
  const request = async (kind: RequestKind, url: string): Promise<RequestResult> => {
    calls.push([kind, url]);
    const answer = answers[url];
    if (!answer) throw new Error(`unexpected request ${url}`);
    return Array.isArray(answer) ? answer.shift()! : answer;
  };
  return { calls, request };
}

describe('processSong', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  function queued(artist: string, title: string, alt?: { artist: string; title: string }) {
    queue.insert(store, alt ? [{ artist, title }, alt] : [{ artist, title }], 'bulk', '2026-10-07T10:00:00+00:00');
    return queue.find(store, [{ artist, title }])!;
  }

  test('search, match, lyrics: stored under every name, row done', async () => {
    const row = queued('להקת הנח"ל', 'שיר לשלום', { artist: 'Lehakat Hanachal', title: 'Shir Lashalom' });
    const { calls, request } = script({
      [searchUrl('שיר לשלום')]: searchPage([['שיר לשלום', 'להקת הנח"ל', '/artist?type=lyrics&lang=1&prfid=578&wrkid=3005']]),
      [LYRICS_URL]: lyricsPage('שורה ראשונה\nשורה שנייה'),
    });
    assert.equal(await processSong(store, row, request, DEFAULT_RULES, () => NOW), 'done');
    assert.deepEqual(calls.map((c) => c[0]), ['search', 'lyrics']);
    assert.equal(store.get('להקת הנח"ל', 'שיר לשלום')?.lyrics, 'שורה ראשונה\nשורה שנייה');
    assert.equal(store.get('Lehakat Hanachal', 'Shir Lashalom')?.sourceRef, LYRICS_URL);
    const after = queue.find(store, [row])!;
    assert.deepEqual([after.status, after.attempts, after.lyricsUrl], ['done', 1, LYRICS_URL]);
  });
  test('the alternate title gets its own search only when the first finds nothing', async () => {
    const row = queued('להקת הנח"ל', 'שיר השלום', { artist: 'להקת הנח"ל', title: 'שיר לשלום' });
    const { calls, request } = script({
      [searchUrl('שיר השלום')]: searchPage([]),
      [searchUrl('שיר לשלום')]: searchPage([['שיר לשלום', 'להקת הנח"ל', '/artist?type=lyrics&lang=1&prfid=578&wrkid=3005']]),
      [LYRICS_URL]: lyricsPage('שורה'),
    });
    assert.equal(await processSong(store, row, request, DEFAULT_RULES, () => NOW), 'done');
    assert.deepEqual(calls.map((c) => c[0]), ['search', 'search', 'lyrics']);
  });
  test('no match: not_found with a retry time a week ahead and what was searched', async () => {
    const row = queued('אמן', 'שיר');
    const { request } = script({
      [searchUrl('שיר')]: searchPage([['שיר אחר', 'אמן', '/artist?type=lyrics&wrkid=9']]),
      [artistSearchUrl('אמן')]: artistResults([]),
    });
    assert.equal(await processSong(store, row, request, DEFAULT_RULES, () => NOW), 'not_found');
    const after = queue.find(store, [row])!;
    assert.equal(after.status, 'not_found');
    assert.equal(after.retryAfter, '2026-10-14T12:00:00+00:00');
  });
  test('a song on page 2 is found by following the next page', async () => {
    const row = queued('יהודה פוליקר', 'כשתגדל');
    const polikar = `${BASE_URL}/artist?type=lyrics&lang=1&prfid=459&wrkid=1796`;
    const { calls, request } = script({
      [searchUrl('כשתגדל')]: searchPage([['כשתגדל', 'אייל גולן', '/artist?type=lyrics&lang=1&prfid=92&wrkid=38593']], '?q=a&type=lyrics&page=2'),
      [`${BASE_URL}/searchSongs?q=a&type=lyrics&page=2`]: searchPage([['כשתגדל', 'יהודה פוליקר', '/artist?type=lyrics&lang=1&prfid=459&wrkid=1796']]),
      [polikar]: lyricsPage('שורה'),
    });
    assert.equal(await processSong(store, row, request, DEFAULT_RULES, () => NOW), 'done');
    assert.deepEqual(calls.map((c) => c[0]), ['search', 'search', 'lyrics']);
    assert.equal(queue.find(store, [row])?.lyricsUrl, polikar);
  });
  test('paging stops at the page limit and the note says how far it looked', async () => {
    const row = queued('אמן', 'שיר');
    const { calls, request } = script({
      [searchUrl('שיר')]: searchPage([['שיר', 'אחר', '/artist?type=lyrics&wrkid=1']], '?q=a&page=2'),
      [`${BASE_URL}/searchSongs?q=a&page=2`]: searchPage([['שיר', 'עוד אחד', '/artist?type=lyrics&wrkid=2']], '?q=a&page=3'),
      [artistSearchUrl('אמן')]: artistResults([]),
    });
    assert.equal(await processSong(store, row, request, { ...DEFAULT_RULES, maxSearchPages: 2 }, () => NOW), 'not_found');
    assert.deepEqual(calls.map((c) => c[0]), ['search', 'search', 'artist']);
    assert.match(String((store.db.prepare('SELECT result FROM queue').get() as { result: string }).result), /2 results on 2 pages for "שיר"/);
  });
  test('a challenge counts no attempt and stores nothing', async () => {
    const row = queued('אמן', 'שיר');
    const { request } = script({ [searchUrl('שיר')]: { outcome: 'challenge', detail: 'perfdrive' } });
    assert.equal(await processSong(store, row, request, DEFAULT_RULES, () => NOW), 'challenge');
    assert.deepEqual([queue.find(store, [row])?.attempts, queue.find(store, [row])?.status], [0, 'pending']);
  });
  test('errors count attempts; the fifth fails the row for a day', async () => {
    const row = queued('אמן', 'שיר');
    const { request } = script({ [searchUrl('שיר')]: { outcome: 'error', detail: 'timeout' } });
    for (let i = 0; i < 4; i += 1) {
      assert.equal(await processSong(store, queue.find(store, [row])!, request, DEFAULT_RULES, () => NOW), 'error');
    }
    assert.equal(queue.find(store, [row])?.status, 'pending');
    await processSong(store, queue.find(store, [row])!, request, DEFAULT_RULES, () => NOW);
    const failed = queue.find(store, [row])!;
    assert.deepEqual([failed.status, failed.attempts, failed.retryAfter], ['failed', 5, '2026-10-08T12:00:00+00:00']);
  });
  test('restart: a saved lyrics_url skips the search, and the song is stored once', async () => {
    const row = queued('להקת הנח"ל', 'שיר לשלום');
    const stop = new Error('stopped');
    const first = script({
      [searchUrl('שיר לשלום')]: searchPage([['שיר לשלום', 'להקת הנח"ל', '/artist?type=lyrics&lang=1&prfid=578&wrkid=3005']]),
    });
    const crashing = async (kind: RequestKind, url: string) => {
      if (kind === 'lyrics') throw stop; // the server stops here
      return first.request(kind, url);
    };
    await assert.rejects(processSong(store, row, crashing, DEFAULT_RULES, () => NOW), /stopped/);
    const between = queue.find(store, [row])!;
    assert.deepEqual([between.status, between.attempts, between.lyricsUrl], ['pending', 0, LYRICS_URL]);

    const second = script({ [LYRICS_URL]: lyricsPage('שורה') });
    assert.equal(await processSong(store, between, second.request, DEFAULT_RULES, () => NOW), 'done');
    assert.deepEqual(second.calls, [['lyrics', LYRICS_URL]]);
    assert.equal(store.count(), 1);
  });
  test('a page without lyrics is not_found', async () => {
    const row = queued('אמן', 'שיר');
    queue.setLyricsUrl(store, row, LYRICS_URL, '2026-10-07T10:00:00+00:00');
    const { request } = script({ [LYRICS_URL]: lyricsPage('instrumental') });
    assert.equal(await processSong(store, queue.find(store, [row])!, request, DEFAULT_RULES, () => NOW), 'not_found');
    assert.match(queue.find(store, [row])?.lyricsUrl ?? '', /wrkid=3005/);
  });
  test('a row with no Hebrew name is skipped without a request', async () => {
    const row = queued('Band', 'Song', { artist: 'Other Band', title: 'Song (Live)' });
    const { calls, request } = script({});
    assert.equal(await processSong(store, row, request, DEFAULT_RULES, () => NOW), 'skipped');
    assert.deepEqual(calls, []);
    const after = queue.find(store, [row])!;
    assert.deepEqual([after.status, after.retryAfter], ['skipped', null]);
    assert.match(String((store.db.prepare('SELECT result FROM queue').get() as { result: string }).result), /no Hebrew/);
  });
  test('a Hebrew artist with an English title is searched by the title', async () => {
    const row = queued('משינה', 'Rakevet');
    const { calls, request } = script({
      [searchUrl('Rakevet')]: searchPage([]),
      [artistSearchUrl('משינה')]: artistResults([['משינה', 77]]),
      [worksUrl(77)]: worksResult(77, [['רכבת לילה לקהיר', 5]]),
    });
    assert.equal(await processSong(store, row, request, DEFAULT_RULES, () => NOW), 'not_found');
    assert.deepEqual(calls.map((c) => c[1]), [searchUrl('Rakevet'), artistSearchUrl('משינה'), worksUrl(77)]);
  });
  test('calibration compares and stores nothing', async () => {
    store.put('להקת הנח"ל', 'שיר לשלום', 'שורה ראשונה שורה שנייה', SOURCE_EMBEDDED);
    store.db.prepare(
      "INSERT INTO queue (artist_key, title_key, artist, title, purpose, status, lyrics_url, added_at, updated_at) "
      + "VALUES ('להקת הנחל', 'שיר לשלום', 'להקת הנח\"ל', 'שיר לשלום', 'calibrate', 'pending', ?, 'x', 'x')",
    ).run(LYRICS_URL);
    const row = queue.nextCalibration(store)!;
    const { request } = script({ [LYRICS_URL]: lyricsPage('שורה ראשונה\nשורה שלישית') });
    assert.equal(await processSong(store, row, request, DEFAULT_RULES, () => NOW), 'done');
    assert.equal(store.get('להקת הנח"ל', 'שיר לשלום')?.lyrics, 'שורה ראשונה שורה שנייה');
    assert.equal(queue.find(store, [row])?.status, 'done');
    assert.match(String((store.db.prepare('SELECT result FROM queue').get() as { result: string }).result), /^similarity 0\.75$/);
  });

  describe('artist route', () => {
    const ARTIST = 'אביתר בנאי';
    const PAGE2 = `${BASE_URL}/artist?lang=1&prfid=41&type=works&page=2`;

    test('a title search miss tries the artist: search, every works page, then the lyrics', async () => {
      const row = queued(ARTIST, 'בשבילך');
      const { calls, request } = script({
        [searchUrl('בשבילך')]: searchPage([]),
        [artistSearchUrl(ARTIST)]: artistResults([['אביתר בנאי ומאיר בנאי', 3126], [ARTIST, 41]]),
        [worksUrl(41)]: worksResult(41, [['אבא', 1], ['בשבילך', 14352]], '/artist?lang=1&prfid=41&type=works&page=2'),
        [PAGE2]: worksResult(41, [['תל אביב', 9]]),
        [workUrl(41, 14352)]: lyricsPage('שורה'),
      });
      assert.equal(await processSong(store, row, request, DEFAULT_RULES, () => NOW), 'done');
      assert.deepEqual(calls.map((c) => c[0]), ['search', 'artist', 'works', 'works', 'lyrics']);
      assert.equal(store.get(ARTIST, 'בשבילך')?.sourceRef, workUrl(41, 14352));
      assert.equal(getArtist(store, ARTIST)?.prfid, 41);
    });
    test('a fresh works list in the cache answers without any search', async () => {
      saveArtistSearch(store, ARTIST, { name: ARTIST, prfid: 41 }, '2026-10-01T00:00:00+00:00');
      saveWorks(store, 41, [{ title: 'בשבילך', url: workUrl(41, 14352) }], '2026-10-01T00:00:00+00:00');
      const row = queued(ARTIST, 'בשבילך');
      const { calls, request } = script({ [workUrl(41, 14352)]: lyricsPage('שורה') });
      assert.equal(await processSong(store, row, request, DEFAULT_RULES, () => NOW), 'done');
      assert.deepEqual(calls.map((c) => c[0]), ['lyrics']);
    });
    test('a fresh list without the title: the title search runs, the artist pages do not', async () => {
      saveArtistSearch(store, ARTIST, { name: ARTIST, prfid: 41 }, '2026-10-01T00:00:00+00:00');
      saveWorks(store, 41, [{ title: 'אבא', url: workUrl(41, 1) }], '2026-10-01T00:00:00+00:00');
      const row = queued(ARTIST, 'שיר חדש');
      const { calls, request } = script({ [searchUrl('שיר חדש')]: searchPage([]) });
      assert.equal(await processSong(store, row, request, DEFAULT_RULES, () => NOW), 'not_found');
      assert.deepEqual(calls.map((c) => c[0]), ['search']);
      assert.match(resultOf(store, 'שיר חדש'), /1 songs of "אביתר בנאי"/);
    });
    test('an old list is read again', async () => {
      saveArtistSearch(store, ARTIST, { name: ARTIST, prfid: 41 }, '2026-08-01T00:00:00+00:00');
      saveWorks(store, 41, [{ title: 'אבא', url: workUrl(41, 1) }], '2026-08-01T00:00:00+00:00');
      const row = queued(ARTIST, 'בשבילך');
      const { calls, request } = script({
        [searchUrl('בשבילך')]: searchPage([]),
        [artistSearchUrl(ARTIST)]: artistResults([[ARTIST, 41]]),
        [worksUrl(41)]: worksResult(41, [['בשבילך', 14352]]),
        [workUrl(41, 14352)]: lyricsPage('שורה'),
      });
      assert.equal(await processSong(store, row, request, DEFAULT_RULES, () => NOW), 'done');
      assert.deepEqual(calls.map((c) => c[0]), ['search', 'artist', 'works', 'lyrics']);
    });
    test('no artist with the exact name: remembered, so the next song of that name costs no artist search', async () => {
      const first = queued('להקה בדויה', 'שיר א');
      const one = script({
        [searchUrl('שיר א')]: searchPage([]),
        [artistSearchUrl('להקה בדויה')]: artistResults([['להקה בדויה ואורחים', 7]]),
      });
      assert.equal(await processSong(store, first, one.request, DEFAULT_RULES, () => NOW), 'not_found');
      assert.match(resultOf(store, 'שיר א'), /no artist "להקה בדויה"/);
      const second = queued('להקה בדויה', 'שיר ב');
      const two = script({ [searchUrl('שיר ב')]: searchPage([]) });
      assert.equal(await processSong(store, second, two.request, DEFAULT_RULES, () => NOW), 'not_found');
      assert.deepEqual(two.calls.map((c) => c[0]), ['search']);
    });
    test('both artist names are tried; the alternate title matches in the list', async () => {
      const row = queued('Eviatar Banai', 'Bishvilech', { artist: ARTIST, title: 'בשבילך' });
      const { calls, request } = script({
        [searchUrl('Bishvilech')]: searchPage([]),
        [searchUrl('בשבילך')]: searchPage([]),
        [artistSearchUrl('Eviatar Banai')]: artistResults([]),
        [artistSearchUrl(ARTIST)]: artistResults([[ARTIST, 41]]),
        [worksUrl(41)]: worksResult(41, [['בשבילך', 14352]]),
        [workUrl(41, 14352)]: lyricsPage('שורה'),
      });
      assert.equal(await processSong(store, row, request, DEFAULT_RULES, () => NOW), 'done');
      assert.deepEqual(calls.map((c) => c[0]), ['search', 'search', 'artist', 'artist', 'works', 'lyrics']);
    });
    test('a challenge on a works page: no attempt; the artist search is kept for the restart', async () => {
      const row = queued(ARTIST, 'בשבילך');
      const one = script({
        [searchUrl('בשבילך')]: searchPage([]),
        [artistSearchUrl(ARTIST)]: artistResults([[ARTIST, 41]]),
        [worksUrl(41)]: { outcome: 'challenge', detail: 'perfdrive' },
      });
      assert.equal(await processSong(store, row, one.request, DEFAULT_RULES, () => NOW), 'challenge');
      assert.equal(queue.find(store, [row])!.attempts, 0);
      const two = script({
        [searchUrl('בשבילך')]: searchPage([]),
        [worksUrl(41)]: worksResult(41, [['בשבילך', 14352]]),
        [workUrl(41, 14352)]: lyricsPage('שורה'),
      });
      assert.equal(await processSong(store, queue.find(store, [row])!, two.request, DEFAULT_RULES, () => NOW), 'done');
      assert.deepEqual(two.calls.map((c) => c[0]), ['search', 'works', 'lyrics']);
    });
    test('works pages stop at the page limit', async () => {
      const row = queued(ARTIST, 'בשבילך');
      const { calls, request } = script({
        [searchUrl('בשבילך')]: searchPage([]),
        [artistSearchUrl(ARTIST)]: artistResults([[ARTIST, 41]]),
        [worksUrl(41)]: worksResult(41, [['אבא', 1]], '/artist?lang=1&prfid=41&type=works&page=2'),
        [PAGE2]: worksResult(41, [['בשבילך', 14352]], '/artist?lang=1&prfid=41&type=works&page=3'),
      });
      assert.equal(await processSong(store, row, request, { ...DEFAULT_RULES, maxWorksPages: 1 }, () => NOW), 'not_found');
      assert.deepEqual(calls.map((c) => c[0]), ['search', 'artist', 'works']);
    });
  });
});
