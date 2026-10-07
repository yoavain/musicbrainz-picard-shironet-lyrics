// Fetches one queued song from Shironet. Ported from src/shironet_worker.py process_item.
// Every queue change is committed when it happens, so a stop at any await leaves a
// consistent row: still pending, with lyrics_url once the search found the page.

import type { Store } from './store.ts';
import { SOURCE_SHIRONET, isoTime } from './store.ts';
import type { Name, QueueRow } from './queue.ts';
import * as queue from './queue.ts';
import {
  artistSearchUrl, interpretArtistSearch, interpretLyrics, interpretSearch, interpretWorks, nextPageUrl, pickArtist,
  pickResult, searchUrl, worksUrl,
} from './shironet.ts';
import type { ArtistResult, ExtractedPage, Work } from './shironet.ts';
import { findWork, getArtist, isFresh, saveArtistSearch, saveWorks, worksCount } from './artists.ts';
import { hasHebrewName, normalize } from './text.ts';
import { similarity } from './calibration.ts';

export type RequestKind = 'search' | 'lyrics' | 'artist' | 'works';
export type RequestResult =
  | { outcome: 'ok'; page: ExtractedPage }
  | { outcome: 'challenge'; detail: string }
  | { outcome: 'error'; detail: string };
export type Requester = (kind: RequestKind, url: string) => Promise<RequestResult>;
export type SongOutcome = 'done' | 'not_found' | 'challenge' | 'error' | 'skipped';

export interface FetchRules {
  missTtlHours: number;
  failedRetryHours: number;
  maxAttempts: number;
  /** Search result pages to read per title before "not found" (10 results per page). */
  maxSearchPages: number;
  /** An artist's works pages to read (30 songs per page). */
  maxWorksPages: number;
  /** Days an artist search and a works list stay valid. */
  artistRefreshDays: number;
}

export const DEFAULT_RULES: FetchRules = {
  missTtlHours: 7 * 24, failedRetryHours: 24, maxAttempts: 5, maxSearchPages: 5, maxWorksPages: 40, artistRefreshDays: 30,
};

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

function distinctArtists(names: Name[]): string[] {
  const seen = new Set<string>();
  return names.map((name) => name.artist).filter((artist) => {
    const key = normalize(artist);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

type Step<T> = { ok: true; value: T } | { ok: false; outcome: SongOutcome };

/**
 * The song from the artist's cached works list, when the list is fresh: no request.
 * Returns the match, or null and a note for each artist whose list was checked.
 */
function fromFreshWorks(store: Store, artists: string[], titles: string[], rules: FetchRules, now: Date): { work: Work | null; notes: string[] } {
  const notes: string[] = [];
  for (const artist of artists) {
    const entry = getArtist(store, artist);
    if (!entry || entry.prfid === null || !isFresh(entry.searchedAt, now, rules.artistRefreshDays)
      || !isFresh(entry.worksAt, now, rules.artistRefreshDays)) continue;
    const work = findWork(store, entry.prfid, titles);
    if (work) return { work, notes };
    notes.push(`${worksCount(store, entry.prfid)} songs of "${entry.name}"`);
  }
  return { work: null, notes };
}

/**
 * The artist route: Shironet's artist search (exact name), then every page of that
 * artist's alphabetical works list, cached for artistRefreshDays. A title that a crowded
 * title search buries (a common word) is found here. The artist search is saved before
 * the works pages are read, so a stop in between does not repeat it.
 */
async function viaArtists(
  store: Store, row: QueueRow, request: Requester, rules: FetchRules, now: () => Date, artists: string[], titles: string[],
  notes: string[],
): Promise<Step<Work | null>> {
  for (const artist of artists) {
    let entry = getArtist(store, artist);
    if (!entry || !isFresh(entry.searchedAt, now(), rules.artistRefreshDays)) {
      let pageUrl: string | null = artistSearchUrl(artist);
      let found: ArtistResult | null = null;
      for (let pages = 0; pageUrl && pages < rules.maxSearchPages && !found; pages += 1) {
        const result = await request('artist', pageUrl);
        if (result.outcome !== 'ok') return { ok: false, outcome: failedAttempt(store, row, result, rules, now()) };
        found = pickArtist(interpretArtistSearch(result.page), artist);
        pageUrl = nextPageUrl(result.page);
      }
      saveArtistSearch(store, artist, found, isoTime(now()));
      entry = getArtist(store, artist)!;
    }
    if (entry.prfid === null) {
      notes.push(`no artist "${artist}"`);
      continue;
    }
    if (!isFresh(entry.worksAt, now(), rules.artistRefreshDays)) {
      const works: Work[] = [];
      let pageUrl: string | null = worksUrl(entry.prfid);
      for (let pages = 0; pageUrl && pages < rules.maxWorksPages; pages += 1) {
        const result = await request('works', pageUrl);
        if (result.outcome !== 'ok') return { ok: false, outcome: failedAttempt(store, row, result, rules, now()) };
        works.push(...interpretWorks(result.page));
        pageUrl = nextPageUrl(result.page);
      }
      saveWorks(store, entry.prfid, works, isoTime(now()));
    }
    const work = findWork(store, entry.prfid, titles);
    if (work) return { ok: true, value: work };
    notes.push(`${worksCount(store, entry.prfid)} songs of "${entry.name}"`);
  }
  return { ok: true, value: null };
}

/**
 * Fetches one song. The lyrics page comes from, in order: the artist's cached works list
 * (no request); the title search (names matched exactly, the alternate title searched
 * only when it differs and the first found nothing); the artist route.
 */
export async function processSong(
  store: Store, row: QueueRow, request: Requester, rules: FetchRules, now: () => Date,
): Promise<SongOutcome> {
  const names = rowNames(row);
  // Rows from an older rule or the import may have no Hebrew name: never searched.
  if (!hasHebrewName(names.flatMap((name) => [name.artist, name.title]))) {
    queue.markSkipped(store, row, 'no Hebrew letter in the artist or title', isoTime(now()));
    return 'skipped';
  }
  let url = row.lyricsUrl;
  if (!url) {
    const titles = distinctTitles(names);
    const artists = distinctArtists(names);
    const cached = fromFreshWorks(store, artists, titles, rules, now());
    const searched: string[] = [];
    let match: { url: string } | null = cached.work;
    for (const title of match ? [] : titles) {
      // Shironet shows 10 results per page; a common title needs the next pages too.
      let pageUrl: string | null = searchUrl(title);
      let pages = 0;
      let count = 0;
      while (pageUrl && pages < rules.maxSearchPages) {
        const result = await request('search', pageUrl);
        if (result.outcome !== 'ok') return failedAttempt(store, row, result, rules, now());
        pages += 1;
        const found = interpretSearch(result.page);
        count += found.length;
        match = names.map((name) => pickResult(found, name.artist, name.title)).find((pick) => pick !== null) ?? null;
        if (match) break;
        pageUrl = nextPageUrl(result.page);
      }
      searched.push(pages > 1 ? `${count} results on ${pages} pages for "${title}"` : `${count} results for "${title}"`);
      if (match) break;
    }
    // The artist route only for artists whose fresh list was not checked above.
    const checked = new Set(cached.notes.length > 0 ? artists.filter((artist) => {
      const entry = getArtist(store, artist);
      return entry?.prfid != null && isFresh(entry.worksAt, now(), rules.artistRefreshDays);
    }).map(normalize) : []);
    if (!match) {
      const step = await viaArtists(store, row, request, rules, now, artists.filter((a) => !checked.has(normalize(a))), titles, searched);
      if (!step.ok) return step.outcome;
      match = step.value;
    }
    if (!match) {
      const notes = [...searched, ...cached.notes];
      queue.markNotFound(store, row, `no match in ${notes.join('; ')}`, hoursAhead(now(), rules.missTtlHours), isoTime(now()));
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
