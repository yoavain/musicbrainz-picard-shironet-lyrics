// Schema migrations: forward-only steps, one per version after the base schema in store.ts.
// The store runs the pending steps at open, in one transaction, after copying the database
// (VACUUM INTO) to <data dir>/backups. A step never edits an earlier step: add a new one.
// Mark a step that drops or rewrites data `destructive: true`; the deploy script warns.

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** The version the base schema in store.ts creates. */
export const BASE_VERSION = 1;
export const BACKUP_DIR = 'backups';
export const KEEP_BACKUPS = 5;

export interface Migration {
  /** The version after this step: BASE_VERSION + 1, + 2, ... */
  to: number;
  description: string;
  destructive?: boolean;
  up(db: DatabaseSync): void;
}

/** The steps, in order. */
export const MIGRATIONS: readonly Migration[] = [
  {
    to: 2,
    description: 'artist cache: Shironet performer ids and their works lists (TODO #3)',
    up: (db) => db.exec(`
      CREATE TABLE artists (
          artist_key  TEXT PRIMARY KEY,        -- normalized name as searched
          prfid       INTEGER,                 -- null: no artist with this exact name
          name        TEXT,                    -- Shironet's spelling
          searched_at TEXT NOT NULL,
          works_at    TEXT                     -- when the works list was last read in full
      ) WITHOUT ROWID;
      CREATE TABLE artist_works (
          prfid     INTEGER NOT NULL,
          title_key TEXT NOT NULL,
          title     TEXT NOT NULL,
          url       TEXT NOT NULL,
          PRIMARY KEY (prfid, title_key, url)
      ) WITHOUT ROWID;
    `),
  },
];

export function checkMigrations(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    const expected = BASE_VERSION + index + 1;
    if (migration.to !== expected) {
      throw new Error(`Migration ${index + 1} ("${migration.description}") goes to version ${migration.to}; expected ${expected}`);
    }
  });
}

export function latestVersion(migrations: readonly Migration[] = MIGRATIONS): number {
  return migrations.at(-1)?.to ?? BASE_VERSION;
}

export function pendingMigrations(from: number, migrations: readonly Migration[] = MIGRATIONS): Migration[] {
  return migrations.filter((migration) => migration.to > from);
}

function stamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
}

export function backupName(from: number, to: number, now: Date): string {
  return `pre-v${from}-to-v${to}-${stamp(now)}.sqlite3`;
}

const BACKUP_FILE = /^pre-v\d+-to-v\d+-(\d{8}T\d{6}Z)\.sqlite3$/;

/** Deletes all but the newest `keep` pre-migration copies. Other files in the folder stay. */
export function pruneBackups(dir: string, keep: number = KEEP_BACKUPS): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const copies = names
    .map((name) => ({ name, stamp: BACKUP_FILE.exec(name)?.[1] }))
    .filter((copy): copy is { name: string; stamp: string } => copy.stamp !== undefined)
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
  for (const copy of copies.slice(keep)) rmSync(join(dir, copy.name), { force: true });
}
