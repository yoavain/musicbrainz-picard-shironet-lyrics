import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, SOURCE_EMBEDDED, Store, isoTime } from '../src/store.ts';

describe('isoTime', () => {
  test('uses the Python format, so stored times compare as strings', () => {
    assert.equal(isoTime(new Date(Date.UTC(2026, 9, 6, 10, 0, 0, 999))), '2026-10-06T10:00:00+00:00');
  });
});

describe('Store in memory', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  test('add and get with a loose key', () => {
    assert.equal(store.put('להקת הנח"ל', 'שיר לשלום', 'שורה ראשונה', SOURCE_EMBEDDED, '/a.mp3'), 'added');
    const entry = store.get('להקת הנח״ל', 'שִׁיר לַשָּׁלוֹם (Live)');
    assert.ok(entry);
    assert.equal(entry.artist, 'להקת הנח"ל');
    assert.equal(entry.lyrics, 'שורה ראשונה');
    assert.equal(entry.source, SOURCE_EMBEDDED);
    assert.equal(entry.sourceRef, '/a.mp3');
  });
  test('get missing', () => {
    assert.equal(store.get('a', 'b'), undefined);
    assert.equal(store.get('', 'b'), undefined);
  });
  test('same lyrics answer same', () => {
    store.put('A', 'T', 'text', SOURCE_EMBEDDED);
    assert.equal(store.put('a', 't', 'text \r\n', SOURCE_EMBEDDED), 'same');
    assert.equal(store.count(), 1);
  });
  test('different lyrics are a conflict and keep the first', () => {
    store.put('A', 'T', 'first', SOURCE_EMBEDDED);
    assert.equal(store.put('A', 'T', 'second', SOURCE_EMBEDDED), 'conflict');
    assert.equal(store.get('A', 'T')?.lyrics, 'first');
  });
  test('replace', () => {
    store.put('A', 'T', 'first', SOURCE_EMBEDDED);
    assert.equal(store.put('A', 'T', 'second', 'paste', null, true), 'replaced');
    const entry = store.get('A', 'T');
    assert.deepEqual([entry?.lyrics, entry?.source], ['second', 'paste']);
  });
  test('skipped when a part is empty', () => {
    assert.equal(store.put('', 'T', 'x', SOURCE_EMBEDDED), 'skipped');
    assert.equal(store.put('A', null, 'x', SOURCE_EMBEDDED), 'skipped');
    assert.equal(store.put('A', 'T', ' \n', SOURCE_EMBEDDED), 'skipped');
    assert.equal(store.put('!!!', 'T', 'x', SOURCE_EMBEDDED), 'skipped');
    assert.equal(store.count(), 0);
  });
  test('lookup returns the first cached name', () => {
    store.put('Shlomo Artzi', 'Havtachot', 'from latin tags', SOURCE_EMBEDDED);
    store.put('שלמה ארצי', 'הבטחות', 'from hebrew tags', SOURCE_EMBEDDED);
    const both = [{ artist: 'שלמה ארצי', title: 'הבטחות (Live)' }, { artist: 'Shlomo Artzi', title: 'Havtachot' }];
    assert.equal(store.lookup(both)?.lyrics, 'from hebrew tags');
    assert.equal(store.lookup([...both].reverse())?.lyrics, 'from latin tags');
  });
  test('lookup falls back to later names', () => {
    store.put('Shlomo Artzi', 'Havtachot', 'text', SOURCE_EMBEDDED);
    const names = [{ artist: 'שלמה ארצי', title: 'הבטחות' }, { artist: null, title: null }, { artist: 'Shlomo Artzi', title: 'Havtachot' }];
    assert.equal(store.lookup(names)?.lyrics, 'text');
  });
  test('lookup miss', () => {
    assert.equal(store.lookup([{ artist: 'A', title: 'T' }, { artist: '', title: '' }]), undefined);
    assert.equal(store.lookup([]), undefined);
  });
  test('same source replaces its own entry', () => {
    store.put('A', 'T', 'old', SOURCE_EMBEDDED, '/a.mp3');
    assert.equal(store.put('A', 'T', 'new', SOURCE_EMBEDDED, '/a.mp3'), 'replaced');
    assert.equal(store.get('A', 'T')?.lyrics, 'new');
  });
  test('other source does not replace', () => {
    store.put('A', 'T', 'old', SOURCE_EMBEDDED, '/a.mp3');
    assert.equal(store.put('A', 'T', 'new', SOURCE_EMBEDDED, '/b.mp3'), 'conflict');
    assert.equal(store.put('A', 'T', 'new', SOURCE_EMBEDDED, null), 'conflict');
  });
  test('putNames stores each distinct name once', () => {
    const names = [{ artist: 'Artist', title: 'Song' }, { artist: 'artist', title: 'song (Live)' }, { artist: 'Other', title: 'Song' }];
    assert.deepEqual(store.putNames(names, 'text', SOURCE_EMBEDDED, 'a.mp3', false), ['added', 'added']);
    assert.equal(store.get('Other', 'Song')?.sourceRef, 'a.mp3');
  });
  test('stored text is not normalized', () => {
    store.put('שִׁיר\u200F', 'כותרת', 'שִׁיר\u200F לַשָּׁלוֹם', SOURCE_EMBEDDED);
    const entry = store.get('שיר', 'כותרת');
    assert.equal(entry?.artist, 'שִׁיר\u200F');
    assert.equal(entry?.lyrics, 'שִׁיר\u200F לַשָּׁלוֹם');
  });
  test('transaction rolls back on error', () => {
    assert.throws(() => store.transaction(() => {
      store.put('A', 'T', 'x', SOURCE_EMBEDDED);
      throw new Error('boom');
    }), /boom/);
    assert.equal(store.count(), 0);
  });
  test('nested transactions commit once', () => {
    store.transaction(() => {
      store.put('A', 'T1', 'x', SOURCE_EMBEDDED);
      store.transaction(() => { store.put('A', 'T2', 'y', SOURCE_EMBEDDED); });
    });
    assert.equal(store.count(), 2);
  });
  test('meta', () => {
    assert.equal(store.getMeta('x'), undefined);
    store.setMeta('x', '1');
    assert.equal(store.getMeta('x'), '1');
    assert.equal(store.getMeta('schema_version'), String(SCHEMA_VERSION));
  });
  test('isEmpty', () => {
    assert.equal(store.isEmpty(), true);
    store.put('A', 'T', 'x', SOURCE_EMBEDDED);
    assert.equal(store.isEmpty(), false);
  });
});

describe('Store on disk', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'store-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('data survives reopening', () => {
    const path = join(dir, 'lyrics.sqlite3');
    let store = new Store(path);
    store.put('A', 'T', 'text', SOURCE_EMBEDDED);
    store.close();
    store = new Store(path);
    assert.equal(store.get('A', 'T')?.lyrics, 'text');
    store.close();
  });
  test('a newer schema is refused', () => {
    const path = join(dir, 'lyrics.sqlite3');
    new Store(path).close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
    db.close();
    assert.throws(() => new Store(path), /newer/);
  });
});
