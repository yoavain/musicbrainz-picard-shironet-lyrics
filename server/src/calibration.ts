// Calibration: fetch songs whose lyrics came from the user's own files and compare
// Shironet's lyrics with them. It checks search, matching, parsing and cleaning end to
// end against known answers, and catches the day Shironet changes its pages.

import type { Store } from './store.ts';
import { SOURCE_EMBEDDED } from './store.ts';
import { cacheKey, hasHebrewName } from './text.ts';

export const COUNTER_KEY = 'calibration_since';
export const ALERTED_KEY = 'calibration_alerted';
const ALERT_WINDOW = 10;
const ALERT_MISSES_IN_ROW = 3;
// The result text of a finished calibration sample: "similarity 0.93".
const SCORE = /^similarity (\d+(?:\.\d+)?)$/;

/** 0..1 similarity of two lyrics by words (longest common subsequence), whitespace ignored. */
export function similarity(a: string, b: string): number {
  const left = a.split(/\s+/u).filter(Boolean);
  const right = b.split(/\s+/u).filter(Boolean);
  if (left.length === 0 && right.length === 0) return 1;
  let previous = new Array<number>(right.length + 1).fill(0);
  for (const word of left) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = word === right[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return (2 * previous[right.length]) / (left.length + right.length);
}

function cutoff(now: string, gapDays: number): string {
  const date = new Date(Date.parse(now) - gapDays * 86400_000);
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

/**
 * A random embedded song with a Hebrew name (the only songs the fetcher searches) that
 * has no fetch row and no recent calibration.
 */
export function pickSample(store: Store, now: string, gapDays: number): { artist: string; title: string } | undefined {
  const rows = store.db.prepare(
    'SELECT l.artist, l.title FROM lyrics l WHERE l.source = ? AND NOT EXISTS ('
    + "  SELECT 1 FROM queue q WHERE q.artist_key = l.artist_key AND q.title_key = l.title_key"
    + "  AND (q.purpose = 'fetch' OR q.updated_at > ?)"
    + ') ORDER BY RANDOM()',
  ).iterate(SOURCE_EMBEDDED, cutoff(now, gapDays)) as Iterable<{ artist: string; title: string }>;
  for (const row of rows) {
    if (hasHebrewName([row.artist, row.title])) return { artist: row.artist, title: row.title };
  }
  return undefined;
}

/** Queues one calibration sample. An older calibration row is reset; a fetch row is never touched. */
export function enqueueSample(store: Store, name: { artist: string; title: string }, now: string): void {
  const [artistKey, titleKey] = cacheKey(name.artist, name.title);
  store.db.prepare(
    'INSERT INTO queue (artist_key, title_key, artist, title, purpose, status, priority, added_at, updated_at) '
    + "VALUES (?, ?, ?, ?, 'calibrate', 'pending', 'bulk', ?, ?) "
    + "ON CONFLICT (artist_key, title_key) DO UPDATE SET status = 'pending', attempts = 0, lyrics_url = NULL, "
    + "result = NULL, retry_after = NULL, added_at = excluded.added_at, updated_at = excluded.updated_at "
    + "WHERE queue.purpose = 'calibrate'",
  ).run(artistKey, titleKey, name.artist, name.title, now, now);
}

/** Queues up to `count` distinct samples. Returns how many. */
export function enqueueCalibration(store: Store, count: number, now: string, gapDays: number): number {
  let queued = 0;
  store.transaction(() => {
    while (queued < count) {
      const sample = pickSample(store, now, gapDays);
      if (!sample) break;
      enqueueSample(store, sample, now);
      queued += 1;
    }
  });
  return queued;
}

export function fetchesSinceSample(store: Store): number {
  return store.getJson<number>(COUNTER_KEY) ?? 0;
}

export function countFetch(store: Store): void {
  store.setJson(COUNTER_KEY, fetchesSinceSample(store) + 1);
}

export function resetCounter(store: Store): void {
  store.setJson(COUNTER_KEY, 0);
}

export interface CalibrationReport {
  samples: Array<{ artist: string; title: string; status: string; similarity: number | null }>;
  median: number | null;
  lowest: number | null;
  notFound: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The last finished samples, newest first. */
export function calibrationReport(store: Store, last = 20): CalibrationReport {
  const rows = store.db.prepare(
    "SELECT artist, title, status, result FROM queue WHERE purpose = 'calibrate' AND status IN ('done', 'not_found') "
    + 'ORDER BY updated_at DESC LIMIT ?',
  ).all(last) as unknown as Array<{ artist: string; title: string; status: string; result: string | null }>;
  const samples = rows.map((row) => {
    const match = SCORE.exec(row.result ?? '');
    return { artist: row.artist, title: row.title, status: row.status, similarity: match ? Number(match[1]) : null };
  });
  const scores = samples.flatMap((sample) => (sample.similarity === null ? [] : [sample.similarity]));
  return {
    samples,
    median: median(scores),
    lowest: scores.length ? Math.min(...scores) : null,
    notFound: samples.filter((sample) => sample.status === 'not_found').length,
  };
}

/** Why calibration says Shironet's pages may have changed, or null. */
export function alertReason(store: Store, medianBelow: number): string | null {
  const { samples } = calibrationReport(store, ALERT_WINDOW);
  const newest = samples.slice(0, ALERT_MISSES_IN_ROW);
  if (newest.length === ALERT_MISSES_IN_ROW && newest.every((sample) => sample.status === 'not_found')) {
    return `the last ${ALERT_MISSES_IN_ROW} calibration samples were not found`;
  }
  // The median looks at the last scored samples only; misses in between must not hide it.
  const done = store.db.prepare(
    "SELECT result FROM queue WHERE purpose = 'calibrate' AND status = 'done' ORDER BY updated_at DESC LIMIT ?",
  ).all(ALERT_WINDOW) as unknown as Array<{ result: string | null }>;
  const scores = done.flatMap((row) => {
    const match = SCORE.exec(row.result ?? '');
    return match ? [Number(match[1])] : [];
  });
  const middle = median(scores);
  if (scores.length >= ALERT_WINDOW && middle !== null && middle < medianBelow) {
    return `the median similarity of the last ${ALERT_WINDOW} calibration samples is ${middle.toFixed(2)}`;
  }
  return null;
}
