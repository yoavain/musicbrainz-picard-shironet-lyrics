import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importPythonCache } from '../src/importer.ts';
import { Store } from '../src/store.ts';

const PYTHON_SCHEMA_6 = `
CREATE TABLE lyrics (artist_key TEXT NOT NULL, title_key TEXT NOT NULL, artist TEXT NOT NULL,
  title TEXT NOT NULL, lyrics TEXT NOT NULL, source TEXT NOT NULL, source_ref TEXT,
  updated_at TEXT NOT NULL, PRIMARY KEY (artist_key, title_key)) WITHOUT ROWID;
CREATE TABLE scanned_files (path TEXT PRIMARY KEY, mtime_ns INTEGER NOT NULL, size INTEGER NOT NULL,
  scanned_at TEXT NOT NULL, artist TEXT, title TEXT, has_lyrics INTEGER) WITHOUT ROWID;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE shironet_queue (artist_key TEXT NOT NULL, title_key TEXT NOT NULL, artist TEXT NOT NULL,
  title TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  lyrics_url TEXT, alt_artist TEXT, alt_title TEXT, result TEXT, retry_after TEXT,
  added_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (artist_key, title_key)) WITHOUT ROWID;
CREATE TABLE shironet_requests (id INTEGER PRIMARY KEY, at REAL NOT NULL, kind TEXT NOT NULL,
  outcome TEXT NOT NULL, http_status INTEGER, gap REAL, detail TEXT);
INSERT INTO meta VALUES ('schema_version', '6');
`;

describe('importPythonCache', () => {
  let dir: string;
  let oldPath: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'import-test-'));
    oldPath = join(dir, 'old.sqlite3');
    store = new Store(':memory:');
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeOld(extraSql: string, keepOpen = false): DatabaseSync {
    const db = new DatabaseSync(oldPath);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(PYTHON_SCHEMA_6);
    db.exec(extraSql);
    if (!keepOpen) db.close();
    return db;
  }

  test('copies lyrics, queue and requests', () => {
    writeOld(`
      INSERT INTO lyrics VALUES ('דן תורן', 'אוטו כחול', 'דן תורן', 'אוטו כחול', 'שורה', 'embedded', '/a.mp3', '2026-10-01T00:00:00+00:00');
      INSERT INTO shironet_queue VALUES ('דן תורן', 'טוב לי', 'דן תורן', 'טוב לי', 'fetch', 'not_found', 1, NULL,
        'Dan Toren', 'Tov Li', 'no match', '2026-10-13T00:00:00+00:00', '2026-10-06T00:00:00+00:00', '2026-10-06T00:00:00+00:00');
      INSERT INTO shironet_requests (at, kind, outcome, http_status, gap, detail) VALUES (1.5, 'search', 'ok', 200, NULL, NULL);
      INSERT INTO shironet_requests (at, kind, outcome, http_status, gap, detail) VALUES (130.0, 'lyrics', 'challenge', 302, 128.5, 'https://validate.perfdrive.com/');
    `);
    const report = importPythonCache(oldPath, store);
    assert.deepEqual([report.lyrics, report.queue, report.requests], [1, 1, 2]);
    assert.deepEqual(report.keyChanges, []);
    assert.deepEqual(report.problems, []);
    const entry = store.get('דן תורן', 'אוטו כחול');
    assert.equal(entry?.lyrics, 'שורה');
    assert.equal(entry?.sourceRef, '/a.mp3');
    const row = store.db.prepare('SELECT status, priority, retry_after, alt_artist FROM queue').get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { status: 'not_found', priority: 'bulk', retry_after: '2026-10-13T00:00:00+00:00', alt_artist: 'Dan Toren' });
  });

  test('reports keys that change and keys that now collide', () => {
    writeOld(`
      INSERT INTO lyrics VALUES ('אמן', 'שיר', 'אמן', 'שיר', 'ראשון', 'embedded', NULL, 'x');
      INSERT INTO lyrics VALUES ('אמן', 'שיר${'\u200F'}', 'אמן', 'שיר${'\u200F'}', 'שני', 'embedded', NULL, 'x');
    `);
    const report = importPythonCache(oldPath, store);
    assert.equal(report.lyrics, 1);
    assert.equal(report.keyChanges.length, 1);
    assert.equal(report.keyChanges[0].newKey, 'אמן | שיר');
    assert.deepEqual(report.problems.map((p) => p.problem), ['collision']);
  });

  test('sees rows still in the WAL of an open old database', () => {
    const open = writeOld(`
      PRAGMA wal_autocheckpoint = 0;
      INSERT INTO lyrics VALUES ('אמן', 'שיר', 'אמן', 'שיר', 'שורה', 'embedded', NULL, 'x');
    `, true);
    try {
      const report = importPythonCache(oldPath, store);
      assert.equal(report.lyrics, 1);
    } finally {
      open.close();
    }
  });

  test('refuses a non-empty server database', () => {
    writeOld('');
    store.put('A', 'T', 'x', 'embedded');
    assert.throws(() => importPythonCache(oldPath, store), /not empty/);
  });

  test('refuses another Python schema version', () => {
    writeOld("UPDATE meta SET value = '5' WHERE key = 'schema_version';");
    assert.throws(() => importPythonCache(oldPath, store), /schema version 6/);
  });

  test('refuses a missing file', () => {
    assert.throws(() => importPythonCache(join(dir, 'missing.sqlite3'), store), /not found/);
  });
});
