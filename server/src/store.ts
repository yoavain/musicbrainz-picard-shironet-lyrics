// The lyrics database: lyrics, the Shironet queue, the request log and meta values.
// Only the server opens it (plus the import command while the server is stopped).

import { DatabaseSync } from 'node:sqlite';
import { cacheKey, cleanLyrics } from './text.ts';

export const SCHEMA_VERSION = 1;
export const SOURCE_EMBEDDED = 'embedded';
export const SOURCE_SHIRONET = 'shironet';

export type PutResult = 'added' | 'same' | 'replaced' | 'conflict' | 'skipped';

export interface Entry {
  artist: string;
  title: string;
  lyrics: string;
  source: string;
  sourceRef: string | null;
  updatedAt: string;
}

export interface NameInput {
  artist?: string | null;
  title?: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lyrics (
    artist_key TEXT NOT NULL,
    title_key  TEXT NOT NULL,
    artist     TEXT NOT NULL,
    title      TEXT NOT NULL,
    lyrics     TEXT NOT NULL,
    source     TEXT NOT NULL,
    source_ref TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (artist_key, title_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS queue (
    artist_key  TEXT NOT NULL,
    title_key   TEXT NOT NULL,
    artist      TEXT NOT NULL,
    title       TEXT NOT NULL,
    purpose     TEXT NOT NULL,                 -- 'fetch' | 'calibrate'
    status      TEXT NOT NULL,                 -- 'pending' | 'done' | 'not_found' | 'failed'
    priority    TEXT NOT NULL DEFAULT 'bulk',  -- 'interactive' | 'bulk'
    attempts    INTEGER NOT NULL DEFAULT 0,
    lyrics_url  TEXT,
    alt_artist  TEXT,
    alt_title   TEXT,
    result      TEXT,
    retry_after TEXT,
    added_at    TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (artist_key, title_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS requests (
    id          INTEGER PRIMARY KEY,
    at          REAL NOT NULL,                 -- Unix time, seconds
    kind        TEXT NOT NULL,                 -- 'search' | 'lyrics' | 'home'
    outcome     TEXT NOT NULL,                 -- 'ok' | 'challenge' | 'error'
    http_status INTEGER,
    gap         REAL,
    detail      TEXT,
    url         TEXT,
    artist      TEXT,
    title       TEXT
);
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

/** UTC time as stored: the Python format, so stored times compare correctly as strings. */
export function isoTime(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

interface LyricsRow {
  artist: string;
  title: string;
  lyrics: string;
  source: string;
  source_ref: string | null;
  updated_at: string;
}

export class Store {
  readonly db: DatabaseSync;
  private inTransaction = false;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      if (path !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec(SCHEMA);
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate(): void {
    this.transaction(() => {
      const version = this.getMeta('schema_version');
      if (version === undefined) {
        this.setMeta('schema_version', String(SCHEMA_VERSION));
      } else if (Number(version) > SCHEMA_VERSION) {
        throw new Error(`Database schema version ${version} is newer than supported version ${SCHEMA_VERSION}`);
      }
    });
  }

  close(): void {
    this.db.close();
  }

  /** Runs fn in one write transaction. A nested call joins the outer one. */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  get(artist: string | null | undefined, title: string | null | undefined): Entry | undefined {
    const [artistKey, titleKey] = cacheKey(artist, title);
    if (!artistKey || !titleKey) return undefined;
    const row = this.db.prepare(
      'SELECT artist, title, lyrics, source, source_ref, updated_at FROM lyrics WHERE artist_key = ? AND title_key = ?',
    ).get(artistKey, titleKey) as LyricsRow | undefined;
    return row && {
      artist: row.artist, title: row.title, lyrics: row.lyrics, source: row.source,
      sourceRef: row.source_ref, updatedAt: row.updated_at,
    };
  }

  /** The entry for the first name in `names` that is cached. */
  lookup(names: NameInput[]): Entry | undefined {
    for (const name of names) {
      const entry = this.get(name.artist, name.title);
      if (entry) return entry;
    }
    return undefined;
  }

  /**
   * Stores lyrics for an artist and title. Different lyrics already stored are kept
   * ('conflict') unless `replace` is set or they came from the same `sourceRef`.
   */
  put(
    artist: string | null | undefined,
    title: string | null | undefined,
    lyrics: string | null | undefined,
    source: string,
    sourceRef: string | null = null,
    replace = false,
  ): PutResult {
    const [artistKey, titleKey] = cacheKey(artist, title);
    const text = cleanLyrics(lyrics);
    if (!artistKey || !titleKey || !text) return 'skipped';
    const row = this.db.prepare(
      'SELECT lyrics, source_ref FROM lyrics WHERE artist_key = ? AND title_key = ?',
    ).get(artistKey, titleKey) as { lyrics: string; source_ref: string | null } | undefined;
    if (row) {
      if (row.lyrics === text) return 'same';
      const sameSource = sourceRef !== null && row.source_ref === sourceRef;
      if (!replace && !sameSource) return 'conflict';
    }
    this.db.prepare(
      'INSERT OR REPLACE INTO lyrics (artist_key, title_key, artist, title, lyrics, source, source_ref, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(artistKey, titleKey, artist!.trim(), title!.trim(), text, source, sourceRef, isoTime(new Date()));
    return row ? 'replaced' : 'added';
  }

  /** Stores the same lyrics under each distinct name in `names`. */
  putNames(names: NameInput[], lyrics: string, source: string, sourceRef: string | null, replace: boolean): PutResult[] {
    const seen = new Set<string>();
    const results: PutResult[] = [];
    for (const name of names) {
      const key = cacheKey(name.artist, name.title).join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(this.put(name.artist, name.title, lyrics, source, sourceRef, replace));
    }
    return results;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM lyrics').get() as { n: number }).n;
  }

  isEmpty(): boolean {
    const row = this.db.prepare(
      'SELECT (SELECT COUNT(*) FROM lyrics) + (SELECT COUNT(*) FROM queue) + (SELECT COUNT(*) FROM requests) AS n',
    ).get() as { n: number };
    return row.n === 0;
  }
}
