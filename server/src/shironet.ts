// Shironet URLs, search matching, and the Node side of page reading.
// The browser side (plan 2) extracts an ExtractedPage from the live DOM, where the
// browser has already decoded the charset and the HTML entities.

import { cleanLyrics, collapseLines, normalize, singleLine } from './text.ts';

export const BASE_URL = 'https://shironet.mako.co.il';
export const HOST = 'shironet.mako.co.il';
export const CHALLENGE_HOST = 'perfdrive.com';

/** Text rule for every string below: raw newlines as spaces, each <br> as '\n'. */
export interface ExtractedLink {
  text: string;
  href: string | null;
}

export interface ExtractedPage {
  url: string;
  title: string;
  challenge: boolean;
  /** The a.search_link_name_big elements in page order: song, artist, song, artist, ... */
  links: ExtractedLink[];
  /** null when the page has no span.artist_lyrics_text. */
  lyrics: { song: string; singer: string; text: string } | null;
  /** The href of the "next" link (a.search_nav_bar or a.artist_nav_bar "הבא"), as written. */
  nextPageHref?: string | null;
  /** An artist's works page: the songs of the alphabetical list (a.artist_player_songlist, not the player panel). */
  works?: ExtractedLink[];
}

export interface ArtistResult {
  name: string;
  /** Shironet's id of the performer. */
  prfid: number;
}

export interface Work {
  title: string;
  url: string;
}

export interface SearchResult {
  title: string;
  artist: string;
  url: string;
}

export interface LyricsPage {
  title: string;
  artist: string;
  lyrics: string;
}

/**
 * The search text for a title: no angle brackets (Shironet's firewall blocks tag-like
 * text) and no control characters. Plan 2 decides about quotes after a live test.
 */
export function searchQuery(title: string): string {
  return singleLine(title.replace(/[<>\p{Cc}]/gu, ' '));
}

export function searchUrl(title: string): string {
  return `${BASE_URL}/searchSongs?q=${encodeURIComponent(searchQuery(title))}&type=lyrics`;
}

/** Artist search; its results are a.search_link_name_big links to /artist?lang=1&prfid=N. */
export function artistSearchUrl(name: string): string {
  return `${BASE_URL}/searchArtists?q=${encodeURIComponent(searchQuery(name))}`;
}

/** An artist's songs, alphabetical, 30 per page. */
export function worksUrl(prfid: number): string {
  return `${BASE_URL}/artist?type=works&lang=1&prfid=${prfid}`;
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isLyricsUrl(url: string): boolean {
  const parsed = parseUrl(url.trim());
  if (!parsed || (parsed.hostname !== HOST && !parsed.hostname.endsWith(`.${HOST}`))) return false;
  const types = parsed.searchParams.getAll('type');
  return types.length === 1 && types[0] === 'lyrics' && !!parsed.searchParams.get('wrkid');
}

/** Shironet's id of the song (shared by all its performers), or null. */
export function workId(url: string): string | null {
  return parseUrl(url)?.searchParams.get('wrkid') || null;
}

export function isChallengeUrl(url: string | null | undefined): boolean {
  const host = url ? parseUrl(url)?.hostname ?? '' : '';
  return host === CHALLENGE_HOST || host.endsWith(`.${CHALLENGE_HOST}`);
}

/**
 * The absolute URL of the next search page, or null. Only Shironet URLs are followed.
 * From page 2 on, Shironet's links carry `page` twice ("?page=2&q=…&page=3") and the site
 * reads the first one, so the link is not followed as written: the next URL is the link
 * with its last `page` value as its only `page`.
 */
export function nextPageUrl(page: ExtractedPage): string | null {
  if (!page.nextPageHref) return null;
  let link: URL;
  try {
    link = new URL(page.nextPageHref, page.url);
  } catch {
    return null;
  }
  if (link.hostname !== HOST && !link.hostname.endsWith(`.${HOST}`)) return null;
  const pages = link.searchParams.getAll('page');
  const target = pages[pages.length - 1];
  if (!target) return null;
  link.searchParams.delete('page');
  link.searchParams.set('page', target);
  const url = link.toString();
  return url === page.url ? null : url;
}

/** Song results of a search page, in page order. */
export function interpretSearch(page: ExtractedPage): SearchResult[] {
  const results: SearchResult[] = [];
  for (let index = 0; index + 1 < page.links.length; index += 2) {
    const song = page.links[index];
    const artist = page.links[index + 1];
    if (!song.href) continue;
    let url: string;
    try {
      url = new URL(song.href, BASE_URL).toString();
    } catch {
      continue; // one malformed link must not lose the other results
    }
    if (!isLyricsUrl(url)) continue;
    results.push({ title: singleLine(song.text), artist: singleLine(artist.text), url });
  }
  return results;
}

function shironetUrl(href: string | null): URL | null {
  if (!href) return null;
  const url = parseUrl(new URL(href, BASE_URL).toString());
  return url && (url.hostname === HOST || url.hostname.endsWith(`.${HOST}`)) ? url : null;
}

/** Artists of an artist search page, in page order. */
export function interpretArtistSearch(page: ExtractedPage): ArtistResult[] {
  const artists: ArtistResult[] = [];
  for (const link of page.links) {
    let url: URL | null;
    try {
      url = shironetUrl(link.href);
    } catch {
      continue;
    }
    const prfid = Number(url?.searchParams.get('prfid'));
    if (!url || url.pathname !== '/artist' || !Number.isInteger(prfid) || prfid <= 0) continue;
    artists.push({ name: singleLine(link.text), prfid });
  }
  return artists;
}

/** The artist with exactly this name after normalization, or null. A duet ("X ו-Y") is another artist. */
export function pickArtist(artists: ArtistResult[], name: string | null | undefined): ArtistResult | null {
  const want = normalize(name);
  if (!want) return null;
  return artists.find((artist) => normalize(artist.name) === want) ?? null;
}

/** Songs of a works page, with absolute lyrics URLs, in page order. */
export function interpretWorks(page: ExtractedPage): Work[] {
  const works: Work[] = [];
  for (const link of page.works ?? []) {
    let url: URL | null;
    try {
      url = shironetUrl(link.href);
    } catch {
      continue;
    }
    if (!url || !isLyricsUrl(url.toString())) continue;
    works.push({ title: singleLine(link.text), url: url.toString() });
  }
  return works;
}

/** Song name, performer and cleaned lyrics of a lyrics page, or null without lyrics. */
export function interpretLyrics(page: ExtractedPage): LyricsPage | null {
  if (!page.lyrics) return null;
  const lyrics = cleanLyrics(collapseLines(page.lyrics.text));
  if (!lyrics) return null;
  return { title: singleLine(page.lyrics.song), artist: singleLine(page.lyrics.singer), lyrics };
}

/**
 * The result for this artist and title, or null. The title must match after
 * normalization. The artist must match too, or one name must contain the other
 * ("להקת הנח"ל" and "הנח"ל"). An exact artist wins.
 */
export function pickResult(
  results: SearchResult[],
  artist: string | null | undefined,
  title: string | null | undefined,
): SearchResult | null {
  const wantArtist = normalize(artist);
  const wantTitle = normalize(title);
  if (!wantArtist || !wantTitle) return null;
  let partial: SearchResult | null = null;
  for (const result of results) {
    if (normalize(result.title) !== wantTitle) continue;
    const gotArtist = normalize(result.artist);
    if (gotArtist === wantArtist) return result;
    if (partial === null && gotArtist && (gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist))) {
      partial = result;
    }
  }
  return partial;
}
