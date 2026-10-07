// The queue of songs to fetch from Shironet. Plan 2's worker reads and updates it.

import type { Store } from './store.ts';
import { cacheKey } from './text.ts';

export type Priority = 'interactive' | 'bulk';
// skipped: never searched (no Hebrew letter in any name); final, and never due.
export type QueueStatus = 'pending' | 'done' | 'not_found' | 'failed' | 'skipped';
export type Purpose = 'fetch' | 'calibrate';

export interface Name {
  artist: string;
  title: string;
}

export interface QueueRow {
  artistKey: string;
  titleKey: string;
  artist: string;
  title: string;
  purpose: Purpose;
  status: QueueStatus;
  priority: Priority;
  attempts: number;
  lyricsUrl: string | null;
  retryAfter: string | null;
  altArtist: string | null;
  altTitle: string | null;
  addedAt: string;
}

/** Songs the worker may take now. One parameter: the current time. */
// A miss or failure without a retry time is due at once, as the service already answers.
export const DUE_CONDITION = "(status = 'pending' OR (status IN ('not_found', 'failed') AND (retry_after IS NULL OR retry_after <= ?)))";
const PRIORITY_RANK = "(CASE priority WHEN 'interactive' THEN 0 ELSE 1 END)";
const COLUMNS = 'artist_key, title_key, artist, title, purpose, status, priority, attempts, lyrics_url, retry_after, '
  + 'alt_artist, alt_title, added_at';

interface RawRow {
  artist_key: string; title_key: string; artist: string; title: string; purpose: Purpose;
  status: QueueStatus; priority: Priority; attempts: number; lyrics_url: string | null; retry_after: string | null;
  alt_artist: string | null; alt_title: string | null; added_at: string;
}

function toRow(raw: RawRow): QueueRow {
  return {
    artistKey: raw.artist_key, titleKey: raw.title_key, artist: raw.artist, title: raw.title,
    purpose: raw.purpose, status: raw.status, priority: raw.priority, attempts: raw.attempts, lyricsUrl: raw.lyrics_url,
    retryAfter: raw.retry_after, altArtist: raw.alt_artist, altTitle: raw.alt_title, addedAt: raw.added_at,
  };
}

/** The queue row stored under any of the names, first name first. */
export function find(store: Store, names: Name[]): QueueRow | undefined {
  const select = store.db.prepare(
    `SELECT ${COLUMNS} FROM queue WHERE artist_key = ? AND title_key = ?`,
  );
  for (const name of names) {
    const [artistKey, titleKey] = cacheKey(name.artist, name.title);
    const raw = select.get(artistKey, titleKey) as RawRow | undefined;
    if (raw) return toRow(raw);
  }
  // A row whose alternate name is one of these names (the names arrived swapped).
  const byAlt = store.db.prepare(
    `SELECT ${COLUMNS} FROM queue WHERE alt_artist IS NOT NULL`,
  ).all() as unknown as RawRow[];
  const wanted = new Set(names.map((name) => cacheKey(name.artist, name.title).join('\u0000')));
  const match = byAlt.find((raw) => wanted.has(cacheKey(raw.alt_artist, raw.alt_title).join('\u0000')));
  return match && toRow(match);
}

/** Queues a song for fetching. names[0] is the primary name; names[1], if any, the alternate. */
export function insert(store: Store, names: Name[], priority: Priority, now: string): void {
  const [primary, alternate] = names;
  const [artistKey, titleKey] = cacheKey(primary.artist, primary.title);
  store.db.prepare(
    'INSERT OR IGNORE INTO queue (artist_key, title_key, artist, title, purpose, status, priority, '
    + "alt_artist, alt_title, added_at, updated_at) VALUES (?, ?, ?, ?, 'fetch', 'pending', ?, ?, ?, ?, ?)",
  ).run(
    artistKey, titleKey, primary.artist.trim(), primary.title.trim(), priority,
    alternate?.artist.trim() ?? null, alternate?.title.trim() ?? null, now, now,
  );
}

/** Puts a row back to a fresh pending fetch. */
export function reset(store: Store, row: QueueRow, now: string): void {
  store.db.prepare(
    "UPDATE queue SET purpose = 'fetch', status = 'pending', attempts = 0, lyrics_url = NULL, "
    + 'result = NULL, retry_after = NULL, updated_at = ? WHERE artist_key = ? AND title_key = ?',
  ).run(now, row.artistKey, row.titleKey);
}

/** Gives a row its alternate name (a row has at most one). */
export function setAlternate(store: Store, row: QueueRow, name: Name, now: string): void {
  store.db.prepare('UPDATE queue SET alt_artist = ?, alt_title = ?, updated_at = ? WHERE artist_key = ? AND title_key = ?')
    .run(name.artist.trim(), name.title.trim(), now, row.artistKey, row.titleKey);
}

export function setPriority(store: Store, row: QueueRow, priority: Priority, now: string): void {
  store.db.prepare('UPDATE queue SET priority = ?, updated_at = ? WHERE artist_key = ? AND title_key = ?')
    .run(priority, now, row.artistKey, row.titleKey);
}

/** An estimate of the row's place among due fetches: by priority, then by age. 1 is next. */
export function position(store: Store, row: QueueRow, now: string): number {
  const current = store.db.prepare('SELECT priority, added_at FROM queue WHERE artist_key = ? AND title_key = ?')
    .get(row.artistKey, row.titleKey) as { priority: Priority; added_at: string };
  const rank = current.priority === 'interactive' ? 0 : 1;
  const ahead = store.db.prepare(
    `SELECT COUNT(*) AS n FROM queue WHERE purpose = 'fetch' AND ${DUE_CONDITION} `
    + `AND (${PRIORITY_RANK} < ? OR (${PRIORITY_RANK} = ? AND added_at < ?))`,
  ).get(now, rank, rank, current.added_at) as { n: number };
  return ahead.n + 1;
}

export function dueCount(store: Store, now: string): number {
  return (store.db.prepare(`SELECT COUNT(*) AS n FROM queue WHERE purpose = 'fetch' AND ${DUE_CONDITION}`)
    .get(now) as { n: number }).n;
}

export function counts(store: Store): Array<{ purpose: string; status: string; priority: string; count: number }> {
  const rows = store.db.prepare(
    'SELECT purpose, status, priority, COUNT(*) AS count FROM queue GROUP BY purpose, status, priority '
    + 'ORDER BY purpose, status, priority',
  ).all() as unknown as Array<{ purpose: string; status: string; priority: string; count: number }>;
  return rows.map((row) => ({ purpose: row.purpose, status: row.status, priority: row.priority, count: row.count }));
}

// --- worker operations: each is one statement, committed at once -----------------

/** The next fetch the worker should take. */
export function nextDue(store: Store, now: string): QueueRow | undefined {
  const raw = store.db.prepare(
    `SELECT ${COLUMNS} FROM queue WHERE purpose = 'fetch' AND ${DUE_CONDITION} `
    + `ORDER BY ${PRIORITY_RANK}, status != 'pending', attempts, added_at LIMIT 1`,
  ).get(now) as RawRow | undefined;
  return raw && toRow(raw);
}

/** The oldest pending calibration sample. */
export function nextCalibration(store: Store): QueueRow | undefined {
  const raw = store.db.prepare(
    `SELECT ${COLUMNS} FROM queue WHERE purpose = 'calibrate' AND status = 'pending' ORDER BY added_at LIMIT 1`,
  ).get() as RawRow | undefined;
  return raw && toRow(raw);
}

function updateRow(store: Store, row: QueueRow, assignments: string, values: Array<string | number | null>, now: string): void {
  store.db.prepare(`UPDATE queue SET ${assignments}, updated_at = ? WHERE artist_key = ? AND title_key = ?`)
    .run(...values, now, row.artistKey, row.titleKey);
}

export function setLyricsUrl(store: Store, row: QueueRow, url: string, now: string): void {
  updateRow(store, row, 'lyrics_url = ?', [url], now);
}

export function markDone(store: Store, row: QueueRow, result: string, now: string): void {
  updateRow(store, row, "status = 'done', result = ?, attempts = attempts + 1, retry_after = NULL", [result], now);
}

export function markNotFound(store: Store, row: QueueRow, result: string, retryAfter: string, now: string): void {
  updateRow(store, row, "status = 'not_found', result = ?, attempts = attempts + 1, retry_after = ?", [result, retryAfter], now);
}

export function markSkipped(store: Store, row: QueueRow, reason: string, now: string): void {
  updateRow(store, row, "status = 'skipped', result = ?, retry_after = NULL", [reason], now);
}

/** One failed attempt. With a retry time the row becomes 'failed' until then. */
export function markError(store: Store, row: QueueRow, detail: string, failedRetryAfter: string | null, now: string): void {
  if (failedRetryAfter === null) {
    updateRow(store, row, 'result = ?, attempts = attempts + 1', [detail], now);
  } else {
    updateRow(store, row, "status = 'failed', result = ?, attempts = attempts + 1, retry_after = ?", [detail, failedRetryAfter], now);
  }
}

/**
 * Sets songs not found back to pending now, without waiting for their retry time. Calibration
 * misses too: a calibration sample is never retried on its own, and after a search change
 * it should be measured with the current code. Each row keeps its purpose.
 */
export function requeueNotFound(store: Store, now: string): number {
  const { changes } = store.db.prepare(
    "UPDATE queue SET status = 'pending', attempts = 0, lyrics_url = NULL, retry_after = NULL, updated_at = ? "
    + "WHERE status = 'not_found'",
  ).run(now);
  return Number(changes);
}

export interface RequestEntry {
  at: number;
  kind: 'search' | 'lyrics' | 'home' | 'artist' | 'works';
  outcome: 'ok' | 'challenge' | 'error';
  httpStatus: number | null;
  detail: string | null;
  url: string | null;
  artist: string | null;
  title: string | null;
}

export function logRequest(store: Store, entry: RequestEntry): void {
  const previous = (store.db.prepare('SELECT MAX(at) AS at FROM requests').get() as { at: number | null }).at;
  store.db.prepare(
    'INSERT INTO requests (at, kind, outcome, http_status, gap, detail, url, artist, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(entry.at, entry.kind, entry.outcome, entry.httpStatus, previous === null ? null : entry.at - previous,
    entry.detail, entry.url, entry.artist, entry.title);
}

export function recentRequests(store: Store, limit: number): Array<RequestEntry & { gap: number | null }> {
  const rows = store.db.prepare(
    'SELECT at, kind, outcome, http_status, gap, detail, url, artist, title FROM requests ORDER BY at DESC, id DESC LIMIT ?',
  ).all(limit) as unknown as Array<{
    at: number; kind: RequestEntry['kind']; outcome: RequestEntry['outcome']; http_status: number | null;
    gap: number | null; detail: string | null; url: string | null; artist: string | null; title: string | null;
  }>;
  return rows.map((row) => ({
    at: row.at, kind: row.kind, outcome: row.outcome, httpStatus: row.http_status, gap: row.gap,
    detail: row.detail, url: row.url, artist: row.artist, title: row.title,
  }));
}

/** Deletes requests older than `before` (Unix seconds). Returns how many. */
export function pruneRequests(store: Store, before: number): number {
  return Number(store.db.prepare('DELETE FROM requests WHERE at < ?').run(before).changes);
}
