// Database tools for operations: a consistent copy and a health check. Both open the
// database read-only and take no server lock, so they run while the server runs (the
// nightly backup in the container) and never create or change the source.

import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function openReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/**
 * Copies the database to target with VACUUM INTO: one consistent snapshot, the WAL
 * included. Writes a temporary file next to target, then renames it over target, so a
 * reader of target never sees half a copy.
 */
export function backupDatabase(source: string, target: string): void {
  if (resolve(source).toLowerCase() === resolve(target).toLowerCase()) {
    throw new Error(`${target} is the same file as the database`);
  }
  const db = openReadOnly(source);
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(resolve(target)), { recursive: true });
    rmSync(temporary, { force: true });
    db.prepare('VACUUM INTO ?').run(temporary);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    db.close();
  }
  renameSync(temporary, target);
}

export interface CheckReport {
  ok: boolean;
  /** PRAGMA integrity_check lines: ['ok'] when sound. */
  integrity: string[];
  schemaVersion: number | null;
  counts: { lyrics: number; requests: number; queue: Record<string, number> };
}

/** PRAGMA integrity_check plus row counts. Throws when the file is missing or not a database. */
export function checkDatabase(path: string): CheckReport {
  const db = openReadOnly(path);
  try {
    const integrity = (db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[])
      .map((row) => row.integrity_check);
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    const queue: Record<string, number> = {};
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM queue GROUP BY status ORDER BY status').all() as { status: string; n: number }[]) {
      queue[row.status] = row.n;
    }
    return {
      ok: integrity.length === 1 && integrity[0] === 'ok',
      integrity,
      schemaVersion: version ? Number(version.value) : null,
      counts: { lyrics: count('SELECT COUNT(*) AS n FROM lyrics'), requests: count('SELECT COUNT(*) AS n FROM requests'), queue },
    };
  } finally {
    db.close();
  }
}
