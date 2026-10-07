// server.lock in the data dir: one server (or one import) at a time.
// The operating system holds the lock (an exclusive SQLite file lock), so it is released
// when the process ends in any way, a crash included. No PIDs: a PID that Windows
// reuses after a reboot can never block the server.

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function lockPath(dataDir: string): string {
  return join(dataDir, 'server.lock');
}

function isBusy(error: unknown): boolean {
  return /locked|busy/i.test((error as Error).message);
}

function isNotADatabase(error: unknown): boolean {
  return /not a database/i.test((error as Error).message);
}

function tryLock(path: string): DatabaseSync {
  const db = new DatabaseSync(path); // timeout 0: a held lock fails at once
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    // A real write: in exclusive locking mode, SQLite keeps the EXCLUSIVE lock until
    // close() only after the connection has written. The PID is for people reading
    // the file; nothing trusts it.
    db.exec('CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL)');
    db.exec('DELETE FROM holder');
    db.prepare('INSERT INTO holder (pid) VALUES (?)').run(process.pid);
    db.exec('COMMIT');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Takes the lock, or throws when another process holds it. Returns the release function. */
export function acquireLock(dataDir: string): () => void {
  const path = lockPath(dataDir);
  let db: DatabaseSync;
  try {
    db = tryLock(path);
  } catch (error) {
    if (isBusy(error)) {
      throw new Error(`Another server or import is using ${dataDir} (it holds ${path})`);
    }
    if (!isNotADatabase(error)) throw error;
    // A leftover file that is not a lock database (for example an old PID file):
    // nobody can hold a lock on it, so replace it.
    rmSync(path, { force: true });
    db = tryLock(path);
  }
  return () => db.close();
}

/** True when another process holds the lock. */
export function isLocked(dataDir: string): boolean {
  if (!existsSync(lockPath(dataDir))) return false; // nobody can hold a lock on a missing file
  try {
    acquireLock(dataDir)();
    return false;
  } catch (error) {
    if (/is using/.test((error as Error).message)) return true;
    throw error;
  }
}
