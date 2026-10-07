import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, processSong } from '../src/fetcher.ts';
import type { RequestKind, RequestResult } from '../src/fetcher.ts';
import { BASE_URL, searchUrl } from '../src/shironet.ts';
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
    const { request } = script({ [searchUrl('שיר')]: searchPage([['שיר אחר', 'אמן', '/artist?type=lyrics&wrkid=9']]) });
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
    });
    assert.equal(await processSong(store, row, request, { ...DEFAULT_RULES, maxSearchPages: 2 }, () => NOW), 'not_found');
    assert.equal(calls.length, 2);
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
});
