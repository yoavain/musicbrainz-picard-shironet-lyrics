"""Export lyrics from audio file tags to sidecar files, for players such as Plex that
do not read embedded lyrics.

The sidecar is the audio file's path with a new extension, next to it:
`01 - Song.mp3` -> `01 - Song.lrc` (timed lyrics) or `01 - Song.txt` (plain lyrics).
UTF-8, newlines as LF. This module reads tags and writes files only: it does not
touch the lyrics cache. No Picard or Qt imports.
"""

from __future__ import annotations

from dataclasses import dataclass
import enum
import os

import mutagen
from mutagen._vorbis import VCommentDict  # base class of FLAC, Ogg and Opus comments
from mutagen.apev2 import APEv2
from mutagen.asf import ASFTags
from mutagen.id3 import ID3
from mutagen.mp4 import MP4Tags

from .lyrics_text import LRC, TXT, clean_lyrics, is_lrc, sidecar_path, strip_language_prefix

# SYLT time stamp format 2 means milliseconds. Format 1 (MPEG frames) is not converted.
SYLT_MILLISECONDS = 2


@dataclass(frozen=True)
class FileLyrics:
    text: str
    kind: str  # LRC | TXT
    source: str  # the tag it came from, for the report: 'SYLT', 'USLT', 'LYRICS' ...


class Outcome(enum.Enum):
    WRITTEN = 'written'
    UNCHANGED = 'unchanged'  # overwrite was asked, but the sidecar already holds the same text
    EXISTS = 'exists'  # a .lrc or .txt sidecar exists: skipped without reading the tags
    NO_LYRICS = 'no lyrics'
    UNSUPPORTED = 'unsupported'  # mutagen does not know the format


def lrc_time(milliseconds: int) -> str:
    """[mm:ss.xx], the usual LRC time tag. Minutes go past 59 for long tracks."""
    centiseconds = max(0, int(milliseconds)) // 10
    minutes, centiseconds = divmod(centiseconds, 6000)
    return f'[{minutes:02d}:{centiseconds // 100:02d}.{centiseconds % 100:02d}]'


def sylt_to_lrc(entries) -> str:
    """LRC text from SYLT (text, milliseconds) pairs, sorted by time."""
    lines = []
    for text, milliseconds in sorted(entries, key=lambda entry: entry[1]):
        text = text.replace('\r', '').strip('\n')
        lines.append(lrc_time(milliseconds) + text)
    return '\n'.join(lines)


def _normalize_text(text: str) -> str:
    """Remove a "heb||" prefix, use LF newlines, trim trailing spaces and outer blank lines."""
    text = strip_language_prefix(text).replace('\r\n', '\n').replace('\r', '\n')
    return '\n'.join(line.rstrip() for line in text.split('\n')).strip('\n')


def _first_text(values) -> tuple[str, int]:
    """The first non-empty value and its index, normalized."""
    for index, value in enumerate(values):
        text = _normalize_text(str(value))
        if text.strip():
            return text, index
    return '', -1


def _values(tags, key: str) -> list:
    value = tags.get(key)
    return [] if value is None else list(value)


def read_file_lyrics(path: str) -> FileLyrics | None | Outcome:
    """The lyrics to export from one file: synced (SYLT) first, then unsynced.

    Returns Outcome.UNSUPPORTED for a format mutagen does not know, None when the
    file has no lyrics. Raises mutagen.MutagenError or OSError on unreadable files.
    """
    audio = mutagen.File(path)
    if audio is None:
        return Outcome.UNSUPPORTED
    tags = audio.tags
    if tags is None:
        return None

    unsynced: list = []
    names: list[str] = []
    if isinstance(tags, ID3):
        for frame in tags.getall('SYLT'):
            if frame.format == SYLT_MILLISECONDS and any(text.strip() for text, _ in frame.text):
                return FileLyrics(sylt_to_lrc(frame.text), LRC, 'SYLT')
        frames = sorted(tags.getall('USLT'), key=lambda frame: (frame.desc != '', frame.desc))
        unsynced = [frame.text for frame in frames]
        names = ['USLT'] * len(unsynced)
    elif isinstance(tags, VCommentDict):
        keys = ['lyrics', 'unsyncedlyrics', 'syncedlyrics'] + sorted(
            key for key in tags.keys() if key.startswith(('lyrics:', 'unsyncedlyrics:'))
        )
        for key in keys:
            values = tags.get(key, [])
            unsynced += values
            names += [key.upper()] * len(values)
    else:
        for tag_type, key in ((MP4Tags, '\xa9lyr'), (APEv2, 'Lyrics'), (ASFTags, 'WM/Lyrics')):
            if isinstance(tags, tag_type):
                unsynced = _values(tags, key)
                names = [key.replace('\xa9', '(c)')] * len(unsynced)
                break

    text, index = _first_text(unsynced)
    if not text:
        return None
    return FileLyrics(text, LRC if is_lrc(text) else TXT, names[index])


def existing_sidecar(audio_path: str) -> str | None:
    """The .lrc or .txt next to the audio file, if either exists."""
    for kind in (LRC, TXT):
        candidate = sidecar_path(audio_path, kind)
        if os.path.exists(candidate):
            return candidate
    return None


def export_file(path: str, overwrite: bool = False, clean: bool = False, dry_run: bool = False):
    """Write the sidecar for one audio file. Returns (Outcome, sidecar path or None, FileLyrics or None).

    A file that already has a .lrc or .txt sidecar is skipped without reading its tags,
    unless `overwrite` is set.
    """
    existing = existing_sidecar(path)
    if existing is not None and not overwrite:
        return Outcome.EXISTS, existing, None

    lyrics = read_file_lyrics(path)
    if lyrics is Outcome.UNSUPPORTED:
        return Outcome.UNSUPPORTED, None, None
    if lyrics is not None and clean and lyrics.kind == TXT:
        cleaned = clean_lyrics(lyrics.text)
        lyrics = FileLyrics(cleaned, TXT, lyrics.source) if cleaned else None
    if lyrics is None:
        return Outcome.NO_LYRICS, None, None

    target = sidecar_path(path, lyrics.kind)
    content = lyrics.text + '\n'
    if os.path.exists(target):  # only reached with overwrite
        try:
            with open(target, encoding='utf-8-sig') as f:
                current = f.read().replace('\r\n', '\n')
        except (OSError, UnicodeDecodeError):
            current = None
        if current == content:
            return Outcome.UNCHANGED, target, lyrics
    if not dry_run:
        with open(target, 'w', encoding='utf-8', newline='\n') as f:
            f.write(content)
    return Outcome.WRITTEN, target, lyrics
