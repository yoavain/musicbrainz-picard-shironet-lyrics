// The artist cache (TODO #3): which Shironet performer (prfid) a name is, and that
// performer's whole works list. One artist search plus its works pages then serve every
// song of the artist, until the entry is older than the refresh time.

import type { Store } from './store.ts';
import type { ArtistResult, Work } from './shironet.ts';
import { normalize } from './text.ts';

export interface ArtistEntry {
  prfid: number | null;
  name: string | null;
  searchedAt: string;
  worksAt: string | null;
}

export function getArtist(store: Store, name: string): ArtistEntry | undefined {
  const row = store.db.prepare('SELECT prfid, name, searched_at, works_at FROM artists WHERE artist_key = ?').get(normalize(name)) as
    { prfid: number | null; name: string | null; searched_at: string; works_at: string | null } | undefined;
  return row && { prfid: row.prfid, name: row.name, searchedAt: row.searched_at, worksAt: row.works_at };
}

/** The result of an artist search for this name; null: Shironet has no artist with the exact name. */
export function saveArtistSearch(store: Store, name: string, found: ArtistResult | null, now: string): void {
  const key = normalize(name);
  if (!key) return;
  // The works stay known when the search finds the same performer again.
  const old = getArtist(store, name);
  const worksAt = found && old?.prfid === found.prfid ? old.worksAt : null;
  store.db.prepare('INSERT OR REPLACE INTO artists (artist_key, prfid, name, searched_at, works_at) VALUES (?, ?, ?, ?, ?)')
    .run(key, found?.prfid ?? null, found?.name ?? null, now, worksAt);
}

/** Replaces the performer's works list; every name of that performer is marked as read now. */
export function saveWorks(store: Store, prfid: number, works: Work[], now: string): void {
  store.transaction(() => {
    store.db.prepare('DELETE FROM artist_works WHERE prfid = ?').run(prfid);
    const insert = store.db.prepare('INSERT OR IGNORE INTO artist_works (prfid, title_key, title, url) VALUES (?, ?, ?, ?)');
    for (const work of works) {
      const key = normalize(work.title);
      if (key) insert.run(prfid, key, work.title, work.url);
    }
    store.db.prepare('UPDATE artists SET works_at = ? WHERE prfid = ?').run(now, prfid);
  });
}

export function worksCount(store: Store, prfid: number): number {
  return (store.db.prepare('SELECT COUNT(*) AS n FROM artist_works WHERE prfid = ?').get(prfid) as { n: number }).n;
}

/** The first title (in the given order) on the performer's list; a title listed twice gives the lowest URL. */
export function findWork(store: Store, prfid: number, titles: string[]): Work | null {
  const query = store.db.prepare('SELECT title, url FROM artist_works WHERE prfid = ? AND title_key = ? ORDER BY url LIMIT 1');
  for (const title of titles) {
    const key = normalize(title);
    if (!key) continue;
    const row = query.get(prfid, key) as { title: string; url: string } | undefined;
    if (row) return { title: row.title, url: row.url };
  }
  return null;
}

/** True when the time is set and less than `days` old. */
export function isFresh(at: string | null, now: Date, days: number): boolean {
  return at !== null && now.getTime() - Date.parse(at) < days * 86_400_000;
}
