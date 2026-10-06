"""Shironet (shironet.mako.co.il) URLs and HTML parsing. No Picard or Qt imports.

Shironet has no API. These functions read the public HTML pages:

- Search: /searchSongs?q=<text>&type=lyrics. Each result is a pair of
  `a.search_link_name_big` links: the song (href has type=lyrics, prfid and wrkid),
  then the artist.
- Lyrics: /artist?type=lyrics&lang=1&prfid=<artist id>&wrkid=<work id>. The song name
  is `h1.artist_song_name_txt`, the performer `a.artist_singer_title`, and the
  lyrics `span.artist_lyrics_text` with <br> line breaks.

Shironet is behind Radware Bot Manager. A blocked request is redirected to
validate.perfdrive.com, which shows a CAPTCHA.
"""

from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import parse_qs, quote_plus, urljoin, urlsplit

from .lyrics_cache import clean_lyrics, normalize


BASE_URL = 'https://shironet.mako.co.il'
HOST = 'shironet.mako.co.il'
CHALLENGE_HOST = 'perfdrive.com'


@dataclass(frozen=True)
class SearchResult:
    title: str
    artist: str
    url: str


@dataclass(frozen=True)
class LyricsPage:
    title: str
    artist: str
    lyrics: str


def search_url(title: str) -> str:
    """Search URL for a song title. Shironet lists every performer of the song."""
    return f'{BASE_URL}/searchSongs?q={quote_plus(title.strip())}&type=lyrics'


def is_lyrics_url(url: str) -> bool:
    parts = urlsplit(url.strip())
    query = parse_qs(parts.query)
    return (
        parts.hostname is not None
        and parts.hostname.endswith(HOST)
        and query.get('type') == ['lyrics']
        and 'wrkid' in query
    )


def work_id(url: str) -> str | None:
    """Shironet's id of the song (shared by all its performers), or None."""
    values = parse_qs(urlsplit(url).query).get('wrkid')
    return values[0] if values else None


def is_challenge(url: str | None, html: str | None = None) -> bool:
    """True for the bot-check redirect or page instead of real Shironet content."""
    host = urlsplit(url or '').hostname or ''
    if host == CHALLENGE_HOST or host.endswith('.' + CHALLENGE_HOST):
        return True
    return bool(html) and CHALLENGE_HOST in html and 'artist_lyrics_text' not in html and (
        'search_link_name_big' not in html
    )


class _ClassTextParser(HTMLParser):
    """Collects the text of elements with given (tag, class) pairs, in document order.

    <br> inside a collected element is stored as None, a line break marker.
    """

    def __init__(self, targets: set[tuple[str, str]]):
        super().__init__(convert_charrefs=True)
        self._targets = targets
        self._stack: list[tuple[str, bool]] = []  # (tag, collecting) for open elements
        self._depth = 0  # how many open elements are collected targets
        self._current: dict | None = None
        self.items: list[dict] = []

    def handle_starttag(self, tag, attrs):
        if tag == 'br':
            if self._current is not None:
                self._current['text'].append(None)  # line break marker
            return
        attributes = dict(attrs)
        classes = set((attributes.get('class') or '').split())
        is_target = self._current is None and any(
            tag == target_tag and target_class in classes for target_tag, target_class in self._targets
        )
        if is_target:
            target_class = next(c for t, c in self._targets if t == tag and c in classes)
            self._current = {'class': target_class, 'href': attributes.get('href'), 'text': []}
        self._stack.append((tag, is_target))

    def handle_endtag(self, tag):
        # Pop to the matching open tag; Shironet's HTML is not always well formed.
        for index in range(len(self._stack) - 1, -1, -1):
            if self._stack[index][0] == tag:
                closed = self._stack[index:]
                del self._stack[index:]
                if any(is_target for _, is_target in closed) and self._current is not None:
                    self.items.append(self._current)
                    self._current = None
                return

    def handle_data(self, data):
        if self._current is not None:
            self._current['text'].append(data)


def _text(item: dict) -> str:
    """The collected text. Only <br> breaks lines; raw newlines are whitespace, as in HTML."""
    parts = []
    for part in item['text']:
        parts.append('\n' if part is None else ' '.join(part.split('\n')))
    return '\n'.join(' '.join(line.split()) for line in ''.join(parts).split('\n'))


def _single_line(text: str) -> str:
    return ' '.join(text.split())


def parse_search(html: str) -> list[SearchResult]:
    """Song results of a search page, in page order."""
    parser = _ClassTextParser({('a', 'search_link_name_big')})
    parser.feed(html)
    results = []
    links = parser.items
    for song, artist in zip(links[::2], links[1::2]):
        href = song.get('href') or ''
        url = urljoin(BASE_URL, href)
        if not is_lyrics_url(url):
            continue
        results.append(SearchResult(_single_line(_text(song)), _single_line(_text(artist)), url))
    return results


def pick_result(results: list[SearchResult], artist: str | None, title: str | None) -> SearchResult | None:
    """The result for this artist and title, or None.

    The title must match after normalization. The artist must match too, or one
    name must contain the other ("להקת הנח"ל" and "הנח"ל"). An exact artist wins.
    """
    want_artist, want_title = normalize(artist), normalize(title)
    if not want_artist or not want_title:
        return None
    partial = None
    for result in results:
        if normalize(result.title) != want_title:
            continue
        got_artist = normalize(result.artist)
        if got_artist == want_artist:
            return result
        if partial is None and got_artist and (want_artist in got_artist or got_artist in want_artist):
            partial = result
    return partial


def parse_lyrics_page(html: str) -> LyricsPage | None:
    """Song name, performer and cleaned lyrics of a lyrics page, or None without lyrics."""
    parser = _ClassTextParser({
        ('h1', 'artist_song_name_txt'),
        ('a', 'artist_singer_title'),
        ('span', 'artist_lyrics_text'),
    })
    parser.feed(html)
    found: dict[str, str] = {}
    for item in parser.items:
        found.setdefault(item['class'], _text(item))
    lyrics = clean_lyrics(found.get('artist_lyrics_text'))
    if not lyrics:
        return None
    return LyricsPage(
        _single_line(found.get('artist_song_name_txt', '')),
        _single_line(found.get('artist_singer_title', '')),
        lyrics,
    )
