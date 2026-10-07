// Fetches one queued song from Shironet. Ported from src/shironet_worker.py process_item.
// Every queue change is committed when it happens, so a stop at any await leaves a
// consistent row: still pending, with lyrics_url once the search found the page.

import type { Store } from './store.ts';
import { SOURCE_SHIRONET, isoTime } from './store.ts';
import type { Name, QueueRow } from './queue.ts';
import * as queue from './queue.ts';
import { interpretLyrics, interpretSearch, pickResult, searchUrl } from './shironet.ts';
import type { ExtractedPage, SearchResult } from './shironet.ts';
import { normalize } from './text.ts';
import { similarity } from './calibration.ts';

export type RequestKind = 'search' | 'lyrics';
export type RequestResult =
  | { outcome: 'ok'; page: ExtractedPage }
  | { outcome: 'challenge'; detail: string }
  | { outcome: 'error'; detail: string };
export type Requester = (kind: RequestKind, url: string) => Promise<RequestResult>;
export type SongOutcome = 'done' | 'not_found' | 'challenge' | 'error';

export interface FetchRules {
  missTtlHours: number;
  failedRetryHours: number;
  maxAttempts: number;
}

export const DEFAULT_RULES: FetchRules = { missTtlHours: 7 * 24, failedRetryHours: 24, maxAttempts: 5 };

export function rowNames(row: QueueRow): Name[] {
  const names: Name[] = [{ artist: row.artist, title: row.title }];
  if (row.altArtist && row.altTitle) names.push({ artist: row.altArtist, title: row.altTitle });
  return names;
}

function distinctTitles(names: Name[]): string[] {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const { title } of names) {
    const key = normalize(title);
    if (key && !seen.has(key)) {
      seen.add(key);
      titles.push(title);
    }
  }
  return titles;
}

function hoursAhead(now: Date, hours: number): string {
  return isoTime(new Date(now.getTime() + hours * 3600_000));
}

function failedAttempt(store: Store, row: QueueRow, result: RequestResult, rules: FetchRules, now: Date): SongOutcome {
  if (result.outcome === 'challenge') return 'challenge'; // not the song's fault: no attempt counted
  const detail = result.outcome === 'error' ? result.detail : 'error';
  const failedRetry = row.attempts + 1 >= rules.maxAttempts ? hoursAhead(now, rules.failedRetryHours) : null;
  queue.markError(store, row, detail, failedRetry, isoTime(now));
  return 'error';
}

/**
 * Fetches one song. The names (primary, then alternate) are each matched exactly
 * against the search results. The search uses the primary title; the alternate title
 * gets its own search only when it differs and the first search found no match.
 */
export async function processSong(
  store: Store, row: QueueRow, request: Requester, rules: FetchRules, now: () => Date,
): Promise<SongOutcome> {
  const names = rowNames(row);
  let url = row.lyricsUrl;
  if (!url) {
    const searched: string[] = [];
    let match: SearchResult | null = null;
    for (const title of distinctTitles(names)) {
      const result = await request('search', searchUrl(title));
      if (result.outcome !== 'ok') return failedAttempt(store, row, result, rules, now());
      const found = interpretSearch(result.page);
      searched.push(`${found.length} results for "${title}"`);
      match = names.map((name) => pickResult(found, name.artist, name.title)).find((pick) => pick !== null) ?? null;
      if (match) break;
    }
    if (!match) {
      queue.markNotFound(store, row, `no match in ${searched.join('; ')}`, hoursAhead(now(), rules.missTtlHours), isoTime(now()));
      return 'not_found';
    }
    url = match.url;
    queue.setLyricsUrl(store, row, url, isoTime(now()));
  }

  const result = await request('lyrics', url);
  if (result.outcome !== 'ok') return failedAttempt(store, row, result, rules, now());
  const page = interpretLyrics(result.page);
  if (!page) {
    queue.markNotFound(store, row, 'no lyrics on the page', hoursAhead(now(), rules.missTtlHours), isoTime(now()));
    return 'not_found';
  }

  const lyricsUrl = url;
  if (row.purpose === 'calibrate') {
    const cached = store.lookup(names);
    const score = cached ? similarity(cached.lyrics, page.lyrics) : 0;
    queue.markDone(store, row, `similarity ${score.toFixed(2)}`, isoTime(now()));
    return 'done';
  }
  store.transaction(() => {
    const stored = names.map((name) => store.put(name.artist, name.title, page.lyrics, SOURCE_SHIRONET, lyricsUrl));
    queue.markDone(store, row, stored.join(', '), isoTime(now()));
  });
  return 'done';
}
