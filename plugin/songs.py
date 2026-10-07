"""Turn a Picard file's tags into requests for the lyrics server. No Picard or Qt imports.

The client never cleans or normalizes: it sends names and lyrics as the tags have them,
and the server applies its rules (cache key, cleaning, the Hebrew rule).
"""

from __future__ import annotations

import os

Name = tuple  # (artist, title); either part may be None or ''


def _complete(name: Name) -> tuple[str, str] | None:
    artist, title = ((part or '').strip() for part in name)
    return (artist, title) if artist and title else None


def song_payload(own: Name, matched: Name, language: str | None) -> dict | None:
    """The song for a request: the file's own tags first (what the user edits when a
    title is spelled differently on Shironet), the MusicBrainz name as the alternate
    when it differs. With incomplete own tags the MusicBrainz name is the primary name.
    None when no name is complete."""
    own_name, matched_name = _complete(own), _complete(matched)
    primary = own_name or matched_name
    if primary is None:
        return None
    song: dict = {'artist': primary[0], 'title': primary[1]}
    if own_name and matched_name and matched_name != own_name:
        song['alt'] = {'artist': matched_name[0], 'title': matched_name[1]}
    if language and language.strip():
        song['language'] = language.strip()
    return song


def raw_lyrics(metadata) -> str:
    """The first non-blank unsynced lyrics in Picard metadata, as written in the file.

    Picard reads unsynced lyrics into `lyrics`, and ID3 USLT frames that have a
    description into `lyrics:<description>`. Plain `lyrics` wins.
    """
    names = ['lyrics'] + sorted(name for name in metadata.keys() if name.startswith('lyrics:'))
    for name in names:
        for value in metadata.getall(name):
            if value and value.strip():
                return value
    return ''


def file_ref(path: str) -> str:
    """The file's reference for the server: the same form the Python cache stored."""
    return os.path.normcase(os.path.abspath(path))
