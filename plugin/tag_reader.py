"""Read artist, title and unsynced lyrics from an audio file with mutagen.

Picard bundles mutagen, so this works inside Picard without extra packages. The
tag names follow Picard's own mappings (picard/formats/*.py), so a file read here
gives the same cache key as the same file loaded in Picard.
"""

from __future__ import annotations

from dataclasses import dataclass

import mutagen
from mutagen._vorbis import VCommentDict  # base class of FLAC, Ogg and Opus comments
from mutagen.apev2 import APEv2
from mutagen.asf import ASFTags
from mutagen.id3 import ID3
from mutagen.mp4 import MP4Tags


# Picard joins multiple artist or title values with this separator.
MULTI_VALUE_JOINER = '; '

# Extensions the folder scan reads. mutagen supports all of them.
AUDIO_EXTENSIONS = frozenset({
    '.aif', '.aiff', '.ape', '.dsf', '.flac', '.m4a', '.mp3', '.mp4',
    '.mpc', '.oga', '.ogg', '.opus', '.wav', '.wma', '.wv',
})


@dataclass(frozen=True)
class FileTags:
    artist: str
    title: str
    lyrics: str


def read_tags(path: str) -> FileTags | None:
    """Return the file's tags, or None when mutagen does not know the format.

    Raises mutagen.MutagenError or OSError when the file cannot be read.
    """
    audio = mutagen.File(path)
    if audio is None:
        return None
    tags = audio.tags
    if tags is None:
        return FileTags('', '', '')
    if isinstance(tags, ID3):
        return _read_id3(tags)
    if isinstance(tags, VCommentDict):
        return _read_vorbis(tags)
    if isinstance(tags, MP4Tags):
        return _read_simple(tags, '\xa9ART', '\xa9nam', ['\xa9lyr'])
    if isinstance(tags, APEv2):
        return _read_simple(tags, 'Artist', 'Title', ['Lyrics'])
    if isinstance(tags, ASFTags):
        return _read_simple(tags, 'Author', 'Title', ['WM/Lyrics'])
    return FileTags('', '', '')


def _join(values) -> str:
    return MULTI_VALUE_JOINER.join(str(value) for value in values if str(value).strip())


def _first_lyrics(candidates) -> str:
    """The first non-blank value, as written in the file: the server cleans lyrics."""
    for value in candidates:
        text = str(value)
        if text.strip():
            return text
    return ''


def _read_id3(tags: ID3) -> FileTags:
    artist = _join(text for frame in tags.getall('TPE1') for text in frame.text)
    title = _join(text for frame in tags.getall('TIT2') for text in frame.text)
    # Picard names a USLT frame without description `lyrics` and prefers it.
    frames = sorted(tags.getall('USLT'), key=lambda frame: (frame.desc != '', frame.desc))
    return FileTags(artist, title, _first_lyrics(frame.text for frame in frames))


def _read_vorbis(tags: VCommentDict) -> FileTags:
    # Picard reads UNSYNCEDLYRICS as `lyrics` too; LYRICS is the usual field.
    names = ['lyrics', 'unsyncedlyrics'] + sorted(
        name for name in tags.keys() if name.startswith(('lyrics:', 'unsyncedlyrics:'))
    )
    lyrics = _first_lyrics(value for name in names for value in tags.get(name, []))
    return FileTags(_join(tags.get('artist', [])), _join(tags.get('title', [])), lyrics)


def _read_simple(tags, artist_key: str, title_key: str, lyrics_keys: list[str]) -> FileTags:
    lyrics = _first_lyrics(value for key in lyrics_keys for value in _values(tags, key))
    return FileTags(_join(_values(tags, artist_key)), _join(_values(tags, title_key)), lyrics)


def _values(tags, key: str) -> list:
    value = tags.get(key)
    if value is None:
        return []
    # APEv2 text values iterate over their parts; MP4 and ASF values are lists.
    return list(value)
