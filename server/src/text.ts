// Text rules: cache keys, lyrics cleaning and the Hebrew rule.
// Ported from src/lyrics_cache.py. One deliberate change: keys also drop format
// characters (category Cf), such as the direction marks that Hebrew tags often carry.

// Words that mark a version of a song whose lyrics are the same as the original.
// Hebrew words may carry a one-letter prefix (ב, ה, ו, ל), as in "בהופעה חיה".
const VERSION_WORDS =
  'live|remaster(?:ed)?|version|edit|mix|remix|acoustic|unplugged|mono|stereo|demo|bonus' +
  '|[בהול]?(?:הופעה חיה|גרסה|גרסת|רמיקס|לייב|אקוסטי|אקוסטית)';

// Python's \b knows Unicode letters. JavaScript's \b knows only ASCII, even with the u
// flag, so without these lookarounds the Hebrew version words would never match.
const WORD_START = '(?<![\\p{L}\\p{N}_])';
const WORD_END = '(?![\\p{L}\\p{N}_])';
const VERSION = `${WORD_START}(?:${VERSION_WORDS})${WORD_END}`;

const BRACKET_SUFFIX = new RegExp(`\\s*[(\\[][^()\\[\\]]*${VERSION}[^()\\[\\]]*[)\\]]\\s*$`, 'iu');
const DASH_SUFFIX = new RegExp(`\\s+-\\s+[^-]*${VERSION}[^-]*$`, 'iu');
const FEATURING = new RegExp(`\\s*[(\\[]?\\s*${WORD_START}(?:feat|ft|featuring)${WORD_END}\\.?.*$`, 'iu');
// Hyphen, Hebrew maqaf (U+05BE), the U+2010-U+2015 dashes, slashes and underscore separate words.
const SEPARATORS = /[\-\u05BE\u2010-\u2015\/\\_]+/gu;
const MARKS_AND_FORMAT = /[\p{M}\p{Cf}]/gu;
const PUNCTUATION_AND_SYMBOLS = /[\p{P}\p{S}]/gu;
const WHITESPACE = /\s+/gu;

// Hebrew letters (U+05D0-U+05EA) and their presentation forms (U+FB1D-U+FB4F).
const HEBREW_LETTER = /[\u05D0-\u05EA\uFB1D-\uFB4F]/u;
const HEBREW_LETTERS = /[\u05D0-\u05EA\uFB1D-\uFB4F]/gu;
const LATIN_LETTERS = /[A-Za-z]/g;
const HEBREW_LANGUAGE_CODES = new Set(['heb', 'he', 'iw']);

// "heb||" or "eng|None|" before the lyrics: lyricsify-cli wrote FLAC lyrics this way.
const LANGUAGE_PREFIX = /^[A-Za-z]{3}\|[^|]*\|/;
// Labels of the credit lines that Shironet puts above the lyrics.
const CREDIT_WORDS =
  '(?:ביצוע|מילים|לחן|עיבוד|תרגום|הפקה|גירסה עברית|גרסה עברית|נוסח עברי' +
  '|performed by|arrangement|lyrics|music|words)';
// "מילים: ...", "מילים ולחן: ...", "לחן, עיבוד: ...".
const CREDIT_LINE = new RegExp(
  `^\\s*${CREDIT_WORDS}(?:\\s*,\\s*${CREDIT_WORDS}|\\s+ו${CREDIT_WORDS})*\\s*:`, 'iu',
);
// Credit lines are looked for only near the top. Lower down, "someone said:" lines are lyrics.
export const CREDIT_SEARCH_LINES = 8;
const INSTRUMENTAL = /^[(\[]?\s*(?:instrumental|אינסטרומנטלי|אינסטרומנטל)\s*[)\]]?\.?$/iu;
// A placeholder is the "instrumental" line plus at most a note or two.
export const INSTRUMENTAL_MAX_LINES = 3;

// Python's str.casefold() differs from toLowerCase() on a few characters that survive NFKD.
const CASEFOLD_EXTRA: Record<string, string> = { 'ß': 'ss', 'ς': 'σ' };

function casefold(text: string): string {
  return text.toLowerCase().replace(/[ßς]/gu, (ch) => CASEFOLD_EXTRA[ch] ?? ch);
}

/** The matching form of an artist or title. Only keys use it; stored text stays as given. */
export function normalize(text: string | null | undefined): string {
  if (!text) return '';
  let result = text.normalize('NFKD').replace(MARKS_AND_FORMAT, '');
  result = casefold(result);
  result = result.replace(FEATURING, '');
  let previous: string;
  do {
    previous = result;
    result = result.replace(BRACKET_SUFFIX, '').replace(DASH_SUFFIX, '');
  } while (result !== previous);
  result = result.replace(SEPARATORS, ' ').replace(PUNCTUATION_AND_SYMBOLS, '');
  return result.replace(WHITESPACE, ' ').trim().normalize('NFC');
}

export function cacheKey(artist: string | null | undefined, title: string | null | undefined): [string, string] {
  return [normalize(artist), normalize(title)];
}

export function hasHebrew(text: string | null | undefined): boolean {
  return !!text && HEBREW_LETTER.test(text);
}

/**
 * A song is Hebrew when a name has a Hebrew letter, the language is a Hebrew code,
 * or the lyrics have more Hebrew letters than Latin letters.
 */
export function isHebrewSong(
  names: Array<string | null | undefined>,
  options: { lyrics?: string | null; language?: string | null } = {},
): boolean {
  if (names.some((name) => hasHebrew(name))) return true;
  const language = options.language?.trim().toLowerCase();
  if (language && HEBREW_LANGUAGE_CODES.has(language)) return true;
  if (options.lyrics) {
    const hebrew = options.lyrics.match(HEBREW_LETTERS)?.length ?? 0;
    const latin = options.lyrics.match(LATIN_LETTERS)?.length ?? 0;
    return hebrew > latin;
  }
  return false;
}

/** Removes a leading "heb||"- or "eng|None|"-style prefix (and leading whitespace). */
export function stripLanguagePrefix(text: string): string {
  return text.trimStart().replace(LANGUAGE_PREFIX, '');
}

/**
 * The lyrics without the parts that are not lyrics: line endings normalized, trailing
 * spaces and outer blank lines trimmed, a language prefix and a title-and-credits header
 * removed. An "instrumental" placeholder gives ''.
 */
export function cleanLyrics(text: string | null | undefined): string {
  if (!text) return '';
  let lines = stripLanguagePrefix(text)
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd());
  let lastCredit = -1;
  lines.slice(0, CREDIT_SEARCH_LINES).forEach((line, index) => {
    if (CREDIT_LINE.test(line)) lastCredit = index;
  });
  if (lastCredit >= 0) lines = lines.slice(lastCredit + 1);
  const result = lines.join('\n').trim();
  const filled = result.split('\n').filter((line) => line.trim());
  if (filled.length > 0 && filled.length <= INSTRUMENTAL_MAX_LINES && INSTRUMENTAL.test(filled[0].trim())) {
    return '';
  }
  return result;
}

/** Collapses the whitespace inside each line; keeps the line breaks. */
export function collapseLines(text: string): string {
  return text.split('\n').map((line) => line.split(WHITESPACE).filter(Boolean).join(' ')).join('\n');
}

export function singleLine(text: string): string {
  return text.split(WHITESPACE).filter(Boolean).join(' ');
}
