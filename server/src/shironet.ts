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
