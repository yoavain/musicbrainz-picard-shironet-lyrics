// One-time move from the Python plugin's cache (schema 6) into the server database.
// Reads a copy of the old file and its WAL, so the original is never written and
// Picard may stay open.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Store } from './store.ts';
import { cacheKey } from './text.ts';

export const PYTHON_SCHEMA_VERSION = 6;

export interface KeyChange {
  table: 'lyrics' | 'queue';
  artist: string;
  title: string;
  oldKey: string;
  newKey: string;
}

export interface ImportProblem {
  table: 'lyrics' | 'queue';
  artist: string;
  title: string;
  problem: 'collision' | 'empty_key';
}

export interface ImportReport {
  lyrics: number;
  queue: number;
  requests: number;
  keyChanges: KeyChange[];
  problems: ImportProblem[];
}

interface OldLyrics {
  artist_key: string; title_key: string; artist: string; title: string; lyrics: string;
  source: string; source_ref: string | null; updated_at: string;
}

interface OldQueue {
  artist_key: string; title_key: string; artist: string; title: string; purpose: string; status: string;
  attempts: number; lyrics_url: string | null; alt_artist: string | null; alt_title: string | null;
  result: string | null; retry_after: string | null; added_at: string; updated_at: string;
}

interface OldRequest {
  at: number; kind: string; outcome: string; http_status: number | null; gap: number | null; detail: string | null;
}

export function importPythonCache(oldPath: string, store: Store): ImportReport {
  if (!existsSync(oldPath)) throw new Error(`Old cache not found: ${oldPath}`);
  if (!store.isEmpty()) throw new Error('The server database is not empty; import needs an empty database');
  const dir = mkdtempSync(join(tmpdir(), 'shironet-import-'));
  try {
    const copy = join(dir, 'old.sqlite3');
    // readFileSync opens with full sharing on Windows; copyFileSync (CopyFileW) can fail
    // with a sharing violation while Picard holds the database open for writing.
    writeFileSync(copy, readFileSync(oldPath));
    if (existsSync(`${oldPath}-wal`)) writeFileSync(`${copy}-wal`, readFileSync(`${oldPath}-wal`));
    const old = new DatabaseSync(copy);
    try {
      return copyRows(old, store);
    } finally {
      old.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function copyRows(old: DatabaseSync, store: Store): ImportReport {
  const version = (old.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value;
  if (version !== String(PYTHON_SCHEMA_VERSION)) {
    throw new Error(
      `The old cache has schema version ${version ?? 'none'}; import reads schema version 6. `
      + 'Open it once with the current Python plugin to upgrade it.',
    );
  }
  const report: ImportReport = { lyrics: 0, queue: 0, requests: 0, keyChanges: [], problems: [] };

  /** The new key, or null when it is empty. Records key changes. */
  function newKey(table: 'lyrics' | 'queue', row: { artist_key: string; title_key: string; artist: string; title: string }) {
    const [artistKey, titleKey] = cacheKey(row.artist, row.title);
    if (!artistKey || !titleKey) {
      report.problems.push({ table, artist: row.artist, title: row.title, problem: 'empty_key' });
      return null;
    }
    if (artistKey !== row.artist_key || titleKey !== row.title_key) {
      report.keyChanges.push({
        table, artist: row.artist, title: row.title,
        oldKey: `${row.artist_key} | ${row.title_key}`, newKey: `${artistKey} | ${titleKey}`,
      });
    }
    return [artistKey, titleKey] as const;
  }

  store.transaction(() => {
    const insertLyrics = store.db.prepare(
      'INSERT OR IGNORE INTO lyrics (artist_key, title_key, artist, title, lyrics, source, source_ref, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const row of old.prepare('SELECT * FROM lyrics ORDER BY updated_at').all() as unknown as OldLyrics[]) {
      const key = newKey('lyrics', row);
      if (!key) continue;
      const { changes } = insertLyrics.run(key[0], key[1], row.artist, row.title, row.lyrics, row.source, row.source_ref, row.updated_at);
      if (Number(changes) === 0) report.problems.push({ table: 'lyrics', artist: row.artist, title: row.title, problem: 'collision' });
      else report.lyrics += 1;
    }

    const insertQueue = store.db.prepare(
      'INSERT OR IGNORE INTO queue (artist_key, title_key, artist, title, purpose, status, priority, attempts, '
      + 'lyrics_url, alt_artist, alt_title, result, retry_after, added_at, updated_at) '
      + "VALUES (?, ?, ?, ?, ?, ?, 'bulk', ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of old.prepare('SELECT * FROM shironet_queue ORDER BY added_at').all() as unknown as OldQueue[]) {
      const key = newKey('queue', row);
      if (!key) continue;
      const { changes } = insertQueue.run(
        key[0], key[1], row.artist, row.title, row.purpose, row.status, row.attempts, row.lyrics_url,
        row.alt_artist, row.alt_title, row.result, row.retry_after, row.added_at, row.updated_at,
      );
      if (Number(changes) === 0) report.problems.push({ table: 'queue', artist: row.artist, title: row.title, problem: 'collision' });
      else report.queue += 1;
    }

    const insertRequest = store.db.prepare(
      'INSERT INTO requests (at, kind, outcome, http_status, gap, detail) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const row of old.prepare('SELECT at, kind, outcome, http_status, gap, detail FROM shironet_requests ORDER BY at').all() as unknown as OldRequest[]) {
      insertRequest.run(row.at, row.kind, row.outcome, row.http_status, row.gap, row.detail);
      report.requests += 1;
    }
  });
  return report;
}
