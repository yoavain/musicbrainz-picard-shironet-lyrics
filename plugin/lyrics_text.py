"""Lyrics text rules for the Plex export (lyrics_export.py): the language prefix, the
title-and-credits header, the "instrumental" placeholder.

The lyrics server applies the same rules to everything it stores (server/src/text.ts);
this copy serves only the standalone export, which works without the server.
No Picard or Qt imports.
"""

from __future__ import annotations

import re

# "heb||" or "eng|None|" before the lyrics: lyricsify-cli wrote FLAC lyrics this way.
_LANGUAGE_PREFIX = re.compile(r'^[A-Za-z]{3}\|[^|]*\|')
# Labels of the credit lines that Shironet puts above the lyrics.
_CREDIT_WORDS = (
    r'(?:ביצוע|מילים|לחן|עיבוד|תרגום|הפקה|גירסה עברית|גרסה עברית|נוסח עברי'
    r'|performed by|arrangement|lyrics|music|words)'
)
# "מילים: ...", "מילים ולחן: ...", "לחן, עיבוד: ...".
_CREDIT_LINE = re.compile(
    rf'^\s*{_CREDIT_WORDS}(?:\s*,\s*{_CREDIT_WORDS}|\s+ו{_CREDIT_WORDS})*\s*:', re.IGNORECASE
)
# Credit lines are looked for only near the top. Lower down, "someone said:" lines are lyrics.
CREDIT_SEARCH_LINES = 8
_INSTRUMENTAL = re.compile(r'^[(\[]?\s*(?:instrumental|אינסטרומנטלי|אינסטרומנטל)\s*[)\]]?\.?$', re.IGNORECASE)
# A placeholder is the "instrumental" line plus at most a note or two.
INSTRUMENTAL_MAX_LINES = 3


def strip_language_prefix(text: str) -> str:
    """Remove a leading "heb||"- or "eng|None|"-style prefix (and leading whitespace)."""
    return _LANGUAGE_PREFIX.sub('', text.lstrip())


def clean_lyrics(text: str | None) -> str:
    """Return the lyrics without the parts that are not lyrics.

    Normalizes line endings, trims trailing spaces and outer blank lines, removes a
    "heb||"-style language prefix, and removes a title-and-credits header: every line
    up to the last credit line ("ביצוע:", "מילים:", "לחן:" ...) among the first
    CREDIT_SEARCH_LINES lines. Returns '' for an "instrumental" placeholder.
    """
    if not text:
        return ''
    text = strip_language_prefix(text)
    lines = [line.rstrip() for line in text.replace('\r\n', '\n').replace('\r', '\n').split('\n')]
    credit_lines = [index for index, line in enumerate(lines[:CREDIT_SEARCH_LINES]) if _CREDIT_LINE.match(line)]
    if credit_lines:
        lines = lines[credit_lines[-1] + 1:]
    text = '\n'.join(lines).strip()
    filled = [line for line in text.split('\n') if line.strip()]
    if filled and len(filled) <= INSTRUMENTAL_MAX_LINES and _INSTRUMENTAL.match(filled[0].strip()):
        return ''
    return text
