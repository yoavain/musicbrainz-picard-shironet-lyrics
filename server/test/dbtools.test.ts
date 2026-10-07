import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase, checkDatabase } from '../src/dbtools.ts';
import { SCHEMA_VERSION, SOURCE_EMBEDDED, Store } from '../src/store.ts';

describe('backupDatabase', () => {
  let dir: string;
  let source: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbtools-test-'));
    source = join(dir, 'lyrics.sqlite3');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('copies while the server holds the database open, WAL included', () => {
    const server = new Store(source);
    server.put('אמן', 'שיר', 'שורה', SOURCE_EMBEDDED); // still in the WAL file
    const target = join(dir, 'backups', 'nightly.sqlite3');
    backupDatabase(source, target);
    server.put('אמן', 'שיר 2', 'עוד שורה', SOURCE_EMBEDDED); // the server keeps writing
    server.close();
    const copy = new Store(target);
    assert.equal(copy.get('אמן', 'שיר')?.lyrics, 'שורה');
    assert.equal(copy.get('אמן', 'שיר 2'), undefined);
    copy.close();
  });
  test('overwrites the target and leaves no temporary file', () => {
    const store = new Store(source);
    store.put('A', 'T', 'one', SOURCE_EMBEDDED);
    store.close();
    const target = join(dir, 'copy.sqlite3');
    writeFileSync(target, 'old copy');
    backupDatabase(source, target);
    backupDatabase(source, target);
    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('copy')), ['copy.sqlite3']);
    assert.equal(checkDatabase(target).ok, true);
  });
  test('never creates the source', () => {
    assert.throws(() => backupDatabase(source, join(dir, 'copy.sqlite3')));
    assert.equal(existsSync(source), false);
    assert.equal(existsSync(join(dir, 'copy.sqlite3')), false);
  });
  test('refuses the source as its own target', () => {
    new Store(source).close();
    assert.throws(() => backupDatabase(source, source), /same file/);
  });
});

describe('checkDatabase', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'checkdb-test-'));
    path = join(dir, 'lyrics.sqlite3');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('integrity, schema version and counts', () => {
    const store = new Store(path);
    store.put('A', 'T', 'one', SOURCE_EMBEDDED);
    store.put('B', 'T', 'two', SOURCE_EMBEDDED);
    store.db.exec(`INSERT INTO queue (artist_key, title_key, artist, title, purpose, status, added_at, updated_at)
      VALUES ('x', 'y', 'X', 'Y', 'fetch', 'pending', '2026-10-07T00:00:00+00:00', '2026-10-07T00:00:00+00:00'),
             ('x', 'z', 'X', 'Z', 'fetch', 'not_found', '2026-10-07T00:00:00+00:00', '2026-10-07T00:00:00+00:00')`);
    const report = checkDatabase(path);
    store.close();
    assert.deepEqual(report, {
      ok: true, integrity: ['ok'], schemaVersion: SCHEMA_VERSION,
      counts: { lyrics: 2, requests: 0, queue: { not_found: 1, pending: 1 } },
    });
  });
  test('a file that is not a database fails', () => {
    writeFileSync(path, 'not a database at all, just text that is long enough to be a header');
    assert.throws(() => checkDatabase(path));
  });
  test('a missing file is not created', () => {
    assert.throws(() => checkDatabase(path));
    assert.equal(existsSync(path), false);
  });
});
