import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_EMBEDDED, SOURCE_SHIRONET, Store } from '../src/store.ts';
import { LyricsService, songNames } from '../src/service.ts';
import * as queue from '../src/queue.ts';

const NOW = new Date(Date.UTC(2026, 9, 6, 12, 0, 0));
const HEBREW = { artist: 'דן תורן', title: 'אוטו כחול' };

describe('songNames', () => {
  test('primary first, alternate second', () => {
    assert.deepEqual(songNames({ ...HEBREW, alt: { artist: 'Dan Toren', title: 'Oto Kachol' } }),
      [HEBREW, { artist: 'Dan Toren', title: 'Oto Kachol' }]);
  });
  test('an alternate with the same key is left out', () => {
    assert.deepEqual(songNames({ ...HEBREW, alt: { artist: 'דן תורן', title: 'אוטו כחול (Live)' } }), [HEBREW]);
  });
  test('a primary with an empty key gives way to the alternate', () => {
    assert.deepEqual(songNames({ artist: '!!!', title: 'x', alt: HEBREW }), [HEBREW]);
  });
});

describe('LyricsService', () => {
  let store: Store;
  let service: LyricsService;
  beforeEach(() => {
    store = new Store(':memory:');
    service = new LyricsService(store, () => NOW);
  });
  afterEach(() => { store.close(); });

  test('fetch answers found from the cache under either name', () => {
    store.put('Dan Toren', 'Oto Kachol', 'שורה', SOURCE_SHIRONET);
    const answer = service.fetch({ ...HEBREW, alt: { artist: 'Dan Toren', title: 'Oto Kachol' } }, 'bulk');
    assert.equal(answer.status, 'found');
    assert.equal(queue.counts(store).length, 0);
  });
  test('the cache comes before the Hebrew rule (transliterated tags still hit)', () => {
    store.put('Mashina', 'Rakevet Layla', 'שורה', SOURCE_EMBEDDED);
    assert.equal(service.fetch({ artist: 'Mashina', title: 'Rakevet Layla' }, 'bulk').status, 'found');
  });
  test('a song that is not Hebrew is not queued', () => {
    assert.deepEqual(service.fetch({ artist: 'R.E.M.', title: 'The One I Love' }, 'bulk'), { status: 'not_hebrew' });
    assert.equal(queue.counts(store).length, 0);
  });
  test('a Hebrew language tag alone is not enough to search Shironet', () => {
    assert.deepEqual(service.fetch({ artist: 'Mashina', title: 'Rakevet', language: 'heb' }, 'bulk'), { status: 'not_hebrew' });
  });
  test('a Hebrew artist with an English title counts, and the other way round', () => {
    assert.equal(service.fetch({ artist: 'משינה', title: 'Rakevet' }, 'bulk').status, 'queued');
    assert.equal(service.fetch({ artist: 'Mashina', title: 'רכבת' }, 'bulk').status, 'queued');
    assert.equal(service.fetch({ artist: 'Mashina', title: 'Rakevet', alt: { artist: 'משינה', title: 'Rakevet' } }, 'bulk').status, 'queued');
  });
  test('a skipped row comes back when a Hebrew name arrives', () => {
    queue.insert(store, [{ artist: 'Mashina', title: 'Rakevet' }], 'bulk', '2026-10-06T10:00:00+00:00');
    const row = queue.find(store, [{ artist: 'Mashina', title: 'Rakevet' }])!;
    queue.markSkipped(store, row, 'no Hebrew name', '2026-10-06T10:00:00+00:00');
    const answer = service.fetch({ artist: 'Mashina', title: 'Rakevet', alt: { artist: 'משינה', title: 'רכבת' } }, 'bulk');
    assert.equal(answer.status, 'queued');
    assert.equal(queue.find(store, [{ artist: 'Mashina', title: 'Rakevet' }])?.status, 'pending');
  });
  test('names with no usable key answer no_name', () => {
    assert.deepEqual(service.fetch({ artist: '!!!', title: '\u05B8' }, 'bulk'), { status: 'no_name' });
    assert.deepEqual(service.fetch({ artist: '\u200F', title: 'שיר' }, 'bulk'), { status: 'no_name' });
    assert.equal(queue.counts(store).length, 0);
  });
  test('a new song is queued once, also when asked twice', () => {
    assert.deepEqual(service.fetch(HEBREW, 'bulk'), { status: 'queued', position: 1 });
    assert.deepEqual(service.fetch(HEBREW, 'bulk'), { status: 'queued', position: 1 });
    assert.equal(queue.dueCount(store, '2026-10-06T12:00:00+00:00'), 1);
  });
  test('swapping primary and alternate finds the same row', () => {
    const alt = { artist: 'Dan Toren', title: 'Oto Kachol' };
    service.fetch({ ...HEBREW, alt }, 'bulk');
    service.fetch({ ...alt, alt: HEBREW }, 'bulk');
    const rows = queue.counts(store);
    assert.deepEqual(rows, [{ purpose: 'fetch', status: 'pending', priority: 'bulk', count: 1 }]);
  });
  test('a request with only the stored alternate name finds the same row', () => {
    service.fetch({ artist: 'Mashina', title: 'Rakevet', alt: { artist: 'משינה', title: 'רכבת' } }, 'bulk');
    service.fetch({ artist: 'משינה', title: 'רכבת' }, 'bulk');
    assert.deepEqual(queue.counts(store), [{ purpose: 'fetch', status: 'pending', priority: 'bulk', count: 1 }]);
  });
  test('interactive goes ahead of bulk; a raised row keeps its age', () => {
    let tick = 0;
    const ticking = new LyricsService(store, () => new Date(NOW.getTime() + 1000 * tick++));
    assert.deepEqual(ticking.fetch({ artist: 'אמן', title: 'ראשון' }, 'bulk'), { status: 'queued', position: 1 });
    assert.deepEqual(ticking.fetch({ artist: 'אמן', title: 'שני' }, 'interactive'), { status: 'queued', position: 1 });
    assert.deepEqual(ticking.fetch({ artist: 'אמן', title: 'ראשון' }, 'bulk'), { status: 'queued', position: 2 });
    // Raised to interactive, and older than "שני", so it is next.
    assert.deepEqual(ticking.fetch({ artist: 'אמן', title: 'ראשון' }, 'interactive'), { status: 'queued', position: 1 });
  });
  test('a miss before its retry time answers not_found', () => {
    service.fetch(HEBREW, 'bulk');
    store.db.prepare("UPDATE queue SET status = 'not_found', retry_after = '2026-10-13T12:00:00+00:00'").run();
    assert.deepEqual(service.fetch(HEBREW, 'interactive'), { status: 'not_found', retryAfter: '2026-10-13T12:00:00+00:00' });
  });
  test('a miss past its retry time is queued again', () => {
    service.fetch(HEBREW, 'bulk');
    store.db.prepare("UPDATE queue SET status = 'failed', retry_after = '2026-10-05T12:00:00+00:00'").run();
    assert.equal(service.fetch(HEBREW, 'bulk').status, 'queued');
  });
  test('a row queued without an alternate takes up one that arrives later', () => {
    service.fetch(HEBREW, 'bulk'); // the folder scan: the file's own tags only
    service.fetch({ ...HEBREW, alt: { artist: 'דן תורן', title: 'אוטו כחול (גרסה חדשה)' } }, 'interactive'); // same key: dropped
    const alt = { artist: 'Dan Toren', title: 'Oto Kachol' };
    service.fetch({ ...HEBREW, alt }, 'interactive'); // Picard: with the MusicBrainz name
    const row = queue.find(store, [HEBREW]);
    assert.deepEqual([row?.altArtist, row?.altTitle], ['Dan Toren', 'Oto Kachol']);
  });
  test('a miss that gains an alternate name is due again before its retry time', () => {
    service.fetch(HEBREW, 'bulk');
    store.db.prepare("UPDATE queue SET status = 'not_found', retry_after = '2026-10-13T12:00:00+00:00'").run();
    const answer = service.fetch({ ...HEBREW, alt: { artist: 'Dan Toren', title: 'Oto Kachol' } }, 'interactive');
    assert.equal(answer.status, 'queued');
    assert.equal(queue.dueCount(store, '2026-10-06T12:00:00+00:00'), 1);
  });
  test('a row that already has an alternate keeps it', () => {
    service.fetch({ ...HEBREW, alt: { artist: 'Dan Toren', title: 'Oto Kachol' } }, 'bulk');
    service.fetch({ ...HEBREW, alt: { artist: 'D. Toren', title: 'Blue Car' } }, 'bulk');
    assert.equal(queue.find(store, [HEBREW])?.altTitle, 'Oto Kachol');
  });
  test('a miss without a retry time is due, so "queued" is true', () => {
    service.fetch(HEBREW, 'bulk');
    store.db.prepare("UPDATE queue SET status = 'not_found', retry_after = NULL").run();
    assert.equal(service.fetch(HEBREW, 'bulk').status, 'queued');
    assert.equal(queue.dueCount(store, '2026-10-06T12:00:00+00:00'), 1);
  });
  test('a done row without cached lyrics goes back to pending', () => {
    service.fetch(HEBREW, 'bulk');
    store.db.prepare("UPDATE queue SET status = 'done'").run();
    assert.equal(service.fetch(HEBREW, 'bulk').status, 'queued');
    assert.deepEqual(queue.counts(store), [{ purpose: 'fetch', status: 'pending', priority: 'bulk', count: 1 }]);
  });
  test('lookup never queues', () => {
    assert.equal(service.lookup(HEBREW), undefined);
    assert.equal(queue.counts(store).length, 0);
  });
  test('put stores under both names and reports added', () => {
    const alt = { artist: 'Dan Toren', title: 'Oto Kachol' };
    assert.equal(service.put({ ...HEBREW, alt }, 'שורה', '/a.mp3', false), 'added');
    assert.equal(store.get('Dan Toren', 'Oto Kachol')?.lyrics, 'שורה');
    assert.equal(service.put({ ...HEBREW, alt }, 'שורה', '/a.mp3', false), 'same');
  });
  test('put reports a conflict on either name', () => {
    const alt = { artist: 'Dan Toren', title: 'Oto Kachol' };
    store.put('Dan Toren', 'Oto Kachol', 'אחר', SOURCE_SHIRONET, 'https://x');
    assert.equal(service.put({ ...HEBREW, alt }, 'שורה', '/a.mp3', false), 'conflict');
  });
  test('put of lyrics that clean to nothing answers skipped', () => {
    assert.equal(service.put(HEBREW, 'instrumental', '/a.mp3', false), 'skipped');
    assert.equal(service.put({ artist: '!!!', title: '' }, 'שורה', '/a.mp3', false), 'skipped');
  });
  test('put of a song that is not Hebrew stores nothing', () => {
    assert.equal(service.put({ artist: 'Band', title: 'Song' }, 'An English song', '/a.mp3', false), 'not_hebrew');
    assert.equal(store.count(), 0);
  });
  test('a song the worker is fetching answers fetching', () => {
    const busy = new LyricsService(store, () => NOW, { inFlight: () => ({ artistKey: 'דן תורן', titleKey: 'אוטו כחול' }) });
    busy.fetch(HEBREW, 'bulk');
    assert.deepEqual(busy.fetch(HEBREW, 'interactive'), { status: 'fetching' });
  });
  test('queuing a song wakes the worker', () => {
    let woken = 0;
    const waking = new LyricsService(store, () => NOW, { onQueued: () => { woken += 1; } });
    waking.fetch(HEBREW, 'bulk');
    waking.fetch({ artist: 'R.E.M.', title: 'The One I Love' }, 'bulk'); // not Hebrew: no wake
    assert.equal(woken, 1);
  });
  test('status includes the worker status', () => {
    const withWorker = new LyricsService(store, () => NOW, { extraStatus: () => ({ running: true }) });
    assert.deepEqual(withWorker.status().worker, { running: true });
  });
  test('status counts lyrics and the queue', () => {
    store.put('A', 'B', 'שורה', SOURCE_EMBEDDED);
    service.fetch(HEBREW, 'bulk');
    assert.deepEqual(service.status(), {
      lyrics: 1, due: 1, queue: [{ purpose: 'fetch', status: 'pending', priority: 'bulk', count: 1 }],
    });
  });
});
