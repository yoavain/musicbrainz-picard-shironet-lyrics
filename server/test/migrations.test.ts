import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BASE_VERSION, backupName, checkMigrations, latestVersion, pendingMigrations, pruneBackups,
} from '../src/migrations.ts';
import type { Migration } from '../src/migrations.ts';
import { SOURCE_EMBEDDED, Store } from '../src/store.ts';

const NOW = () => new Date(Date.UTC(2026, 9, 7, 12, 30, 5));

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((row) => row.name === column);
}

const addNote: Migration = {
  to: 2, description: 'lyrics.note',
  up: (db) => db.exec('ALTER TABLE lyrics ADD COLUMN note TEXT'),
};
const addTags: Migration = {
  to: 3, description: 'tags table', destructive: true,
  up: (db) => db.exec('CREATE TABLE tags (name TEXT PRIMARY KEY)'),
};
const broken: Migration = {
  to: 3, description: 'fails',
  up: () => { throw new Error('step failed'); },
};

describe('migration list', () => {
  test('versions must follow the base version without gaps', () => {
    assert.doesNotThrow(() => checkMigrations([]));
    assert.doesNotThrow(() => checkMigrations([addNote, addTags]));
    assert.throws(() => checkMigrations([addTags]), /2/);
    assert.throws(() => checkMigrations([addNote, addNote]), /3/);
  });
  test('latest version and pending steps', () => {
    assert.equal(latestVersion([]), BASE_VERSION);
    assert.equal(latestVersion([addNote, addTags]), 3);
    assert.deepEqual(pendingMigrations(1, [addNote, addTags]), [addNote, addTags]);
    assert.deepEqual(pendingMigrations(2, [addNote, addTags]), [addTags]);
    assert.deepEqual(pendingMigrations(3, [addNote, addTags]), []);
  });
  test('backup names carry both versions and a UTC stamp', () => {
    assert.equal(backupName(1, 3, NOW()), 'pre-v1-to-v3-20261007T123005Z.sqlite3');
  });
});

describe('migrations in the store', () => {
  let dir: string;
  let path: string;
  let backups: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'migrations-test-'));
    path = join(dir, 'lyrics.sqlite3');
    backups = join(dir, 'backups');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function open(migrations: readonly Migration[]) {
    return new Store(path, { migrations, backupDir: backups, now: NOW });
  }

  test('a new database gets the base schema plus every step, and no backup', () => {
    const store = open([addNote, addTags]);
    assert.equal(store.schemaVersion, 3);
    assert.ok(hasColumn(store.db, 'lyrics', 'note'));
    store.close();
    assert.deepEqual(readdirSync(dir).filter((name) => name === 'backups'), []);
  });
  test('an older database is copied first, then migrated in one go', () => {
    const v1 = open([]);
    v1.put('A', 'T', 'text', SOURCE_EMBEDDED);
    v1.close();
    const store = open([addNote, addTags]);
    assert.equal(store.schemaVersion, 3);
    assert.ok(hasColumn(store.db, 'lyrics', 'note'));
    assert.equal(store.get('A', 'T')?.lyrics, 'text');
    store.close();
    assert.deepEqual(readdirSync(backups), ['pre-v1-to-v3-20261007T123005Z.sqlite3']);
    const copy = new DatabaseSync(join(backups, 'pre-v1-to-v3-20261007T123005Z.sqlite3'), { readOnly: true });
    assert.equal((copy.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, '1');
    assert.equal(hasColumn(copy, 'lyrics', 'note'), false);
    copy.close();
  });
  test('a failing step rolls back every step; the backup stays', () => {
    open([]).close();
    assert.throws(() => open([addNote, broken]), /step failed/);
    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, '1');
    assert.equal(hasColumn(db, 'lyrics', 'note'), false);
    db.close();
    assert.equal(readdirSync(backups).length, 1);
  });
  test('a current database is opened without a backup', () => {
    open([addNote]).close();
    open([addNote]).close();
    assert.deepEqual(readdirSync(dir).filter((name) => name === 'backups'), []);
  });
  test('a newer database is refused', () => {
    open([addNote]).close();
    assert.throws(() => open([]), /newer/);
  });
  test('a step list with a gap is refused before anything changes', () => {
    open([]).close();
    assert.throws(() => open([addTags]), /2/);
    assert.deepEqual(readdirSync(dir).filter((name) => name === 'backups'), []);
  });
});

describe('pruneBackups', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prune-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('keeps the newest by stamp, whatever the versions; other files stay', () => {
    const names = [
      'pre-v1-to-v2-20260101T000000Z.sqlite3', 'pre-v2-to-v3-20260201T000000Z.sqlite3',
      'pre-v9-to-v10-20250101T000000Z.sqlite3', 'pre-v3-to-v4-20260301T000000Z.sqlite3',
      'nightly.sqlite3', 'notes.txt',
    ];
    for (const name of names) writeFileSync(join(dir, name), '');
    pruneBackups(dir, 2);
    assert.deepEqual(readdirSync(dir).sort(), [
      'nightly.sqlite3', 'notes.txt', 'pre-v2-to-v3-20260201T000000Z.sqlite3', 'pre-v3-to-v4-20260301T000000Z.sqlite3',
    ]);
  });
  test('a missing folder is fine', () => {
    assert.doesNotThrow(() => pruneBackups(join(dir, 'none'), 5));
    mkdirSync(join(dir, 'empty'));
    assert.doesNotThrow(() => pruneBackups(join(dir, 'empty'), 5));
  });
});
