// All request logic. The HTTP routes only translate between JSON and these calls.

import type { Entry, Store } from './store.ts';
import { SOURCE_EMBEDDED, isoTime } from './store.ts';
import { cacheKey, cleanLyrics, isHebrewSong } from './text.ts';
import * as queue from './queue.ts';
import type { Name, Priority } from './queue.ts';
import { enqueueCalibration } from './calibration.ts';

export interface Song {
  artist: string;
  title: string;
  language?: string;
  alt?: { artist: string; title: string };
}

export type FetchAnswer =
  | { status: 'found'; entry: Entry }
  | { status: 'queued'; position: number }
  | { status: 'not_found' | 'failed'; retryAfter: string | null }
  | { status: 'not_hebrew' }
  | { status: 'no_name' }
  | { status: 'fetching' };

export type PutAnswer = 'added' | 'same' | 'replaced' | 'conflict' | 'skipped' | 'not_hebrew';

export interface ServiceStatus {
  lyrics: number;
  due: number;
  queue: Array<{ purpose: string; status: string; priority: string; count: number }>;
  worker?: Record<string, unknown>;
}

export interface ServiceHooks {
  /** The song the worker is fetching right now (in memory only). */
  inFlight?: () => { artistKey: string; titleKey: string } | null;
  /** Called after a song is queued or due again, to wake the worker. */
  onQueued?: () => void;
  extraStatus?: () => Record<string, unknown>;
}

/**
 * The song's usable names, primary first. A name with an empty key is left out, so
 * an empty primary gives way to the alternate. An alternate with the primary's key
 * is left out.
 */
export function songNames(song: Song): Name[] {
  const names: Name[] = [];
  const seen = new Set<string>();
  for (const name of [song, song.alt]) {
    if (!name) continue;
    const [artistKey, titleKey] = cacheKey(name.artist, name.title);
    if (!artistKey || !titleKey) continue;
    const key = `${artistKey}\u0000${titleKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    names.push({ artist: name.artist, title: name.title });
  }
  return names;
}

function allNames(song: Song): string[] {
  return [song.artist, song.title, song.alt?.artist ?? '', song.alt?.title ?? ''];
}

export class LyricsService {
  private readonly store: Store;
  private readonly now: () => Date;
  private readonly hooks: ServiceHooks;

  constructor(store: Store, now: () => Date = () => new Date(), hooks: ServiceHooks = {}) {
    this.store = store;
    this.now = now;
    this.hooks = hooks;
  }

  lookup(song: Song): Entry | undefined {
    return this.store.lookup(songNames(song));
  }

  /** Cached lyrics, or the song's queue state. Never waits for Shironet. */
  fetch(song: Song, priority: Priority): FetchAnswer {
    const names = songNames(song);
    const entry = this.store.lookup(names);
    if (entry) return { status: 'found', entry };
    if (names.length === 0) return { status: 'no_name' };
    if (!isHebrewSong(allNames(song), { language: song.language })) return { status: 'not_hebrew' };
    const now = isoTime(this.now());
    const answer = this.store.transaction((): FetchAnswer => {
      let row = queue.find(this.store, names);
      if (!row) {
        queue.insert(this.store, names, priority, now);
        row = queue.find(this.store, names)!;
      } else {
        // The folder scan queued the file's own tags; Picard now brings the MusicBrainz
        // name. A miss gets another chance with it, without waiting for its retry time.
        if (row.altArtist === null && this.adoptAlternate(row, names, now) && row.status === 'not_found') {
          queue.reset(this.store, row, now);
          row = { ...row, status: 'pending', retryAfter: null };
        }
        if (row.purpose !== 'fetch' || row.status === 'done') {
          queue.reset(this.store, row, now);
        } else if ((row.status === 'not_found' || row.status === 'failed') && row.retryAfter !== null && row.retryAfter > now) {
          return { status: row.status, retryAfter: row.retryAfter };
        }
      }
      if (priority === 'interactive' && row.priority !== 'interactive') {
        queue.setPriority(this.store, row, 'interactive', now);
      }
      const busy = this.hooks.inFlight?.();
      if (busy && busy.artistKey === row.artistKey && busy.titleKey === row.titleKey) return { status: 'fetching' };
      return { status: 'queued', position: queue.position(this.store, row, now) };
    });
    if (answer.status === 'queued') this.hooks.onQueued?.();
    return answer;
  }

  /** Stores the first name whose key differs from the row's own key as its alternate. */
  private adoptAlternate(row: queue.QueueRow, names: Name[], now: string): boolean {
    const other = names.find((name) => cacheKey(name.artist, name.title).join('\u0000') !== `${row.artistKey}\u0000${row.titleKey}`);
    if (!other) return false;
    queue.setAlternate(this.store, row, other, now);
    return true;
  }

  /** Lyrics a file already has. Stored under every name; the cache's conflict rules apply. */
  put(song: Song, lyrics: string, ref: string | null, replace: boolean): PutAnswer {
    const names = songNames(song);
    const cleaned = cleanLyrics(lyrics);
    if (!cleaned || names.length === 0) return 'skipped';
    if (!isHebrewSong(allNames(song), { lyrics: cleaned, language: song.language })) return 'not_hebrew';
    const results = this.store.transaction(
      () => this.store.putNames(names, cleaned, SOURCE_EMBEDDED, ref, replace),
    );
    if (results.includes('conflict')) return 'conflict';
    return results.find((result) => result !== 'skipped') ?? 'skipped';
  }

  /** Songs not found go back to pending now. */
  requeueNotFound(): number {
    const count = queue.requeueNotFound(this.store, isoTime(this.now()));
    if (count > 0) this.hooks.onQueued?.();
    return count;
  }

  /** Queues up to `count` calibration samples now. */
  enqueueCalibration(count: number, gapDays: number): number {
    const queued = enqueueCalibration(this.store, count, isoTime(this.now()), gapDays);
    if (queued > 0) this.hooks.onQueued?.();
    return queued;
  }

  status(): ServiceStatus {
    const extra = this.hooks.extraStatus?.();
    return {
      lyrics: this.store.count(),
      due: queue.dueCount(this.store, isoTime(this.now())),
      queue: queue.counts(this.store),
      ...(extra ? { worker: extra } : {}),
    };
  }
}
