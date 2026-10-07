import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import * as queue from '../src/queue.ts';

const T0 = '2026-10-07T10:00:00+00:00';
const T1 = '2026-10-07T11:00:00+00:00';

describe('queue operations for the worker', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  function add(title: string, priority: queue.Priority, at: string) {
    queue.insert(store, [{ artist: 'אמן', title }], priority, at);
    return queue.find(store, [{ artist: 'אמן', title }])!;
  }

  test('nextDue: interactive first, then pending before retries, then attempts, then age', () => {
    const old = add('ישן', 'bulk', T0);
    add('חדש', 'bulk', T1);
    assert.equal(queue.nextDue(store, T1)?.title, 'ישן');
    add('דחוף', 'interactive', T1);
    assert.equal(queue.nextDue(store, T1)?.title, 'דחוף');
    queue.markNotFound(store, queue.find(store, [{ artist: 'אמן', title: 'דחוף' }])!, 'no match', T0, T1);
    queue.markError(store, old, 'timeout', null, T1);
    // 'דחוף' is a due retry; pending rows go first within the same priority only.
    assert.equal(queue.nextDue(store, T1)?.title, 'דחוף');
    queue.markDone(store, queue.find(store, [{ artist: 'אמן', title: 'דחוף' }])!, 'added', T1);
    assert.equal(queue.nextDue(store, T1)?.title, 'חדש'); // 0 attempts before 1 attempt
  });
  test('nextDue skips calibration rows and future retries', () => {
    const row = add('שיר', 'bulk', T0);
    queue.markNotFound(store, row, 'no match', '2026-10-14T10:00:00+00:00', T0);
    store.db.prepare("INSERT INTO queue (artist_key, title_key, artist, title, purpose, status, added_at, updated_at) VALUES ('a', 'b', 'A', 'B', 'calibrate', 'pending', ?, ?)").run(T0, T0);
    assert.equal(queue.nextDue(store, T1), undefined);
    assert.equal(queue.nextCalibration(store)?.title, 'B');
  });
  test('setLyricsUrl, then the row carries it', () => {
    const row = add('שיר', 'bulk', T0);
    queue.setLyricsUrl(store, row, 'https://shironet.mako.co.il/artist?type=lyrics&wrkid=1', T1);
    assert.equal(queue.find(store, [{ artist: 'אמן', title: 'שיר' }])?.lyricsUrl, 'https://shironet.mako.co.il/artist?type=lyrics&wrkid=1');
  });
  test('markError counts attempts; with a retry time it fails the row', () => {
    const row = add('שיר', 'bulk', T0);
    queue.markError(store, row, 'timeout', null, T1);
    assert.deepEqual([queue.find(store, [row])?.status, queue.find(store, [row])?.attempts], ['pending', 1]);
    queue.markError(store, row, 'timeout', '2026-10-08T11:00:00+00:00', T1);
    const failed = queue.find(store, [row]);
    assert.deepEqual([failed?.status, failed?.attempts, failed?.retryAfter], ['failed', 2, '2026-10-08T11:00:00+00:00']);
  });
  test('skipped rows are never due and stay skipped on requeue', () => {
    queue.insert(store, [{ artist: 'Band', title: 'Song' }], 'bulk', '2026-10-07T10:00:00+00:00');
    const row = queue.find(store, [{ artist: 'Band', title: 'Song' }])!;
    queue.markSkipped(store, row, 'no Hebrew name', '2026-10-07T10:00:00+00:00');
    const after = queue.find(store, [row])!;
    assert.deepEqual([after.status, after.retryAfter], ['skipped', null]);
    assert.equal(queue.nextDue(store, '2030-01-01T00:00:00+00:00'), undefined);
    assert.equal(queue.dueCount(store, '2030-01-01T00:00:00+00:00'), 0);
    assert.equal(queue.requeueNotFound(store, '2026-10-07T10:00:00+00:00'), 0);
  });
  test('requeueNotFound resets misses only', () => {
    const miss = add('חסר', 'bulk', T0);
    queue.markNotFound(store, miss, 'no match', '2026-10-14T10:00:00+00:00', T0);
    add('ממתין', 'bulk', T0);
    assert.equal(queue.requeueNotFound(store, T1), 1);
    const row = queue.find(store, [miss]);
    assert.deepEqual([row?.status, row?.attempts, row?.retryAfter, row?.lyricsUrl], ['pending', 0, null, null]);
  });
  test('requeueNotFound also resets calibration misses; they stay calibration samples', () => {
    const insert = store.db.prepare(
      "INSERT INTO queue (artist_key, title_key, artist, title, purpose, status, result, added_at, updated_at) "
      + "VALUES (?, ?, ?, ?, 'calibrate', ?, ?, ?, ?)",
    );
    insert.run('יהודה פוליקר', 'כשתגדל', 'יהודה פוליקר', 'כשתגדל', 'not_found', 'no match in 10 results', T0, T0);
    insert.run('משינה', 'אופטיקאי מדופלם', 'משינה', 'אופטיקאי מדופלם', 'done', 'similarity 1.00', T0, T0);
    assert.equal(queue.requeueNotFound(store, T1), 1);
    const sample = queue.nextCalibration(store);
    assert.deepEqual([sample?.title, sample?.purpose, sample?.status], ['כשתגדל', 'calibrate', 'pending']);
    const done = store.db.prepare("SELECT status FROM queue WHERE title = 'אופטיקאי מדופלם'").get() as { status: string };
    assert.equal(done.status, 'done');
  });
  test('request log keeps gaps, newest first, and prunes', () => {
    queue.logRequest(store, { at: 100, kind: 'search', outcome: 'ok', httpStatus: null, detail: null, url: 'u1', artist: 'אמן', title: 'שיר' });
    queue.logRequest(store, { at: 112.5, kind: 'lyrics', outcome: 'challenge', httpStatus: null, detail: 'perfdrive', url: 'u2', artist: 'אמן', title: 'שיר' });
    const recent = queue.recentRequests(store, 10);
    assert.deepEqual(recent.map((r) => [r.kind, r.gap]), [['lyrics', 12.5], ['search', null]]);
    assert.equal(recent[0].artist, 'אמן');
    assert.equal(queue.pruneRequests(store, 105), 1);
    assert.equal(queue.recentRequests(store, 10).length, 1);
  });
});
