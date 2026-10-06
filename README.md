# Shironet Lyrics for MusicBrainz Picard

A plugin for [MusicBrainz Picard](https://picard.musicbrainz.org/) 3 that keeps a local
cache of song lyrics, aimed at Hebrew lyrics from [Shironet](https://shironet.mako.co.il/).

What works today: the plugin collects the lyrics already embedded in your Hebrew songs
into a local SQLite cache, from Picard or from a command-line script, and fills the
**Lyrics** tag of matched tracks from that cache. A separate, slow command-line worker
fetches missing Hebrew lyrics from Shironet into the same cache.

## Features

- **Lyrics from the cache.** When Picard matches a file to a track and the file has no
  lyrics, the plugin fills **Lyrics** from the cache. Right-click files, tracks, albums or
  clusters > **Shironet Lyrics > Lookup Lyrics** does the same on demand, also
  replacing lyrics that differ from the cached ones, and shows a summary. Both look up the
  matched MusicBrainz artist and title first, then the file's own tags. Nothing is written
  to disk until you save.

- **Hebrew songs only.** Shironet is a Hebrew lyrics site, so the cache keeps only Hebrew
  songs. A song is Hebrew when its title or artist contains a Hebrew letter, its language
  tag is Hebrew (`heb`), or its lyrics have more Hebrew letters than Latin letters.
  Other songs are counted as "Not Hebrew" and skipped.
- **Folder scan.** Tools > Shironet Lyrics > *Scan folder into lyrics cache...* reads the
  lyrics embedded in every audio file under a folder. It runs in the background with a
  progress dialog that can cancel, and ends with a summary.
- **Fast rescans.** The cache records each file's size and modification time. A rescan
  reads only new and changed files.
- **Updates while Picard runs.** Every file Picard loads adds its lyrics to the cache.
  Every save updates it; lyrics you changed in that save replace the cached ones.
- **Conflicts are kept, not overwritten.** When another file already gave different
  lyrics for the same artist and title, the cached lyrics stay and the log names the
  file. A file whose own lyrics changed does update its own entry.
- **Lyrics are cleaned before they are stored.** A `heb||` or `eng|None|` prefix (written
  by older lyrics tools into FLAC files) is removed, and so is a title-and-credits header
  (`ביצוע:`, `מילים:`, `לחן:` ... lines near the top). An "instrumental" placeholder
  counts as no lyrics. The files themselves are not changed.
- **Loose matching.** The cache key is artist + title, compared after removing niqqud,
  accents, punctuation, "feat." parts and version suffixes such as "(Live)",
  "- Remastered 2011" or "(בהופעה חיה)".
- **Batch run.** `scripts/scan_folder.py` runs the same scan without Picard, then fetches
  the queued songs from Shironet. See below.

Supported formats: MP3, FLAC, Ogg Vorbis, Opus, M4A/MP4, APE, WavPack, Musepack, WMA,
AIFF, WAV and DSF. Only unsynced lyrics are cached.

## Install

Requires Picard 3.0 or later.

1. In Picard, open **Options > Plugins > Install Plugin**.
2. On the local tab, select this folder.
3. Open **Help > View Log** and find the line `Lyrics cache: using <path> (N songs)`.
   It shows where the cache file is.

The cache is `plugin-data/shironet-lyrics/lyrics.sqlite3` under Picard's app-data folder.
It holds full lyrics text: keep it out of git and out of synced folders.

## Batch run from the command line

```sh
python scripts/scan_folder.py "D:\Music" --notify
```

One command for the whole flow:

1. **Scan**, the same as Picard's Tools menu scan: new and changed files are read, their
   Hebrew lyrics are cached, and Hebrew songs without lyrics are queued for Shironet.
   Unchanged files without lyrics are queued from what the last scan recorded, without
   reading them again.
2. **Fetch**: the Shironet worker (below) runs until no queued song is due. Afterwards
   every queued song is cached, or marked "not found" and left alone until its retry
   time (a week by default).

`--no-fetch` stops after step 1. `--hours`, `--max-requests`, `--stop-on-challenge`,
`--miss-ttl-hours`, `--notify` and `--ntfy-url` are passed to the worker. It writes to the
plugin's cache file by default (`--db` picks another one), prints a summary, and lists
files with conflicts or read errors. It is safe to run while Picard is open. Ctrl+C stops
either step and keeps the work done so far.

It needs `mutagen`. Without an installed `mutagen`, it loads the copy inside the installed
Picard. That works only when your Python has the same version as Picard's bundled Python
(3.14 for Picard 3.0). `--picard-exe` or `PICARD_EXE` points at a Picard installed
elsewhere.

## Export lyrics to sidecar files (for Plex)

Plex does not read embedded lyrics. It reads a `.lrc` (timed) or `.txt` (plain) file in UTF-8
with the same name as the track, in the same folder
([Plex: Adding Local Lyrics](https://support.plex.tv/articles/215916117-adding-local-lyrics/)).
This standalone script writes those files from the tags:

```sh
python scripts/export_lyrics.py "D:\Music" --dry-run   # report only
python scripts/export_lyrics.py "D:\Music"
```

- Works on a whole folder, subfolders included, in any language. It reads tags and writes
  sidecars only: no cache, no database.
- A track that already has a `.lrc` or `.txt` is skipped without reading its tags.
  `--overwrite` re-exports it.
- Synced lyrics (ID3 `SYLT`) become `.lrc`; plain lyrics whose lines carry LRC time tags
  (`[01:23.45]`) become `.lrc` too; other lyrics become `.txt`.
- The text is the tag's text with LF newlines, minus a `heb||`-style prefix. `--clean` also
  removes a title-and-credits header and skips "instrumental" placeholders.
- `--verbose` lists every file written; otherwise the first 20 and the totals.

## Fetch from Shironet (worker)

Shironet blocks automated access after a few requests (a Radware CAPTCHA), so fetching
runs outside Picard, slowly, from a queue in the cache file. The queue is filled by the
folder scan (Picard's or `scan_folder.py`), and by Picard when a Hebrew song misses the
cache on match or on **Lookup Lyrics**. `scan_folder.py` starts the worker by itself; it
can also run on its own:

```sh
python scripts/shironet_worker.py run --notify --hours 8
python scripts/shironet_worker.py status                       # --all-misses lists every miss
python scripts/shironet_worker.py requeue-not-found            # retry misses now, not in a week
python scripts/shironet_worker.py enqueue-calibration 30       # cached songs, to compare
python scripts/shironet_worker.py enqueue-missing "D:\Music"   # queue only, re-reading every file
```

- A song Shironet does not have gets a retry time a week ahead (`--miss-ttl-hours`,
  default 168). A song that failed 5 times on network errors gets one a day ahead.
  Until then the worker skips it; afterwards it is searched again by itself. `status`
  shows each miss with its retry time.

- A song queued from Picard has two names: the file's own artist and title, and the
  matched MusicBrainz name when it differs. Each is matched exactly. The alternate is
  first checked against the same search results, and gets its own search only when its
  title differs and the first search found nothing. Fetched lyrics are stored under both.

- `run` sends one request at a time: a search, then the lyrics page. It waits between
  requests (120 s at first, with jitter) and adjusts the wait: 10% shorter after 10
  successes in a row; on a CAPTCHA it pauses for 30 minutes (doubling on repeats) and
  continues 50% slower. The learned pace is kept in the cache file between runs.
- Fetched lyrics go into the cache with source `shironet`, where Picard finds them on the
  next match or lookup. Calibration songs are only compared with the cached lyrics.
- Matching is exact on purpose: the title must equal a Shironet result after
  normalization, and the artist must equal it or contain it. A song reported as
  "no match" usually has a title spelled differently from Shironet's. Fix the title in
  the tags, and the next `enqueue-missing` queues the corrected title.
- `status` shows the queue, the pace, how many requests passed between CAPTCHAs, how long
  each block lasted, the songs not found (with what was searched), and the calibration
  similarity.
- `--notify` shows a Windows notification on a CAPTCHA and at the end; `--ntfy-url`
  pushes the same messages to an ntfy topic. `--stop-on-challenge` ends the run at the
  first CAPTCHA. Ctrl+C stops after the current request.
- It identifies itself as `shironet-lyrics/0.1`, keeps cookies in
  `shironet-cookies.txt` next to the cache, and needs only the standard library
  (`enqueue-missing` also needs `mutagen`, like `scan_folder.py`).

## Layout

Picard loads a plugin from the repository root, so the root holds only `MANIFEST.toml`
and an `__init__.py` that re-exports `enable` and `disable` from `src/plugin.py`.

| Path | Contents |
|---|---|
| `src/plugin.py` | Picard hooks, the Tools menu action, the background scan job |
| `src/lyrics_cache.py` | SQLite cache, key normalization (no Picard or Qt imports) |
| `src/scanner.py` | Folder walk and incremental scan (no Picard or Qt imports) |
| `src/tag_reader.py` | Reads artist, title and lyrics with `mutagen`, using Picard's tag names |
| `src/shironet.py` | Shironet URLs and HTML parsing: search results, lyrics pages, CAPTCHA detection |
| `src/shironet_queue.py` | The fetch queue and the request log (tables in the cache file) |
| `src/shironet_worker.py` | Pacing, HTTP client, fetching one song, the run loop, the pace report |
| `src/lyrics_export.py` | Reads lyrics from tags (SYLT or plain), decides `.lrc` or `.txt`, writes the sidecar |
| `scripts/scan_folder.py` | Batch run: folder scan, then the Shironet worker |
| `scripts/export_lyrics.py` | Standalone export of embedded lyrics to `.lrc`/`.txt` sidecars, for Plex |
| `scripts/shironet_worker.py` | Command-line Shironet worker: queue, run, status |
| `scripts/_bootstrap.py` | Loads the `src` modules and Picard's bundled `mutagen` without Picard (used by the script and the tests) |
| `tests/` | Unit tests |

## Development

Run the tests from the repository root:

```sh
python -m unittest discover -s tests
```

No packages need installing. The tests use `scripts/_bootstrap.py` to import the `src`
modules without Picard and to load `mutagen` from the installed Picard. When that fails,
the tag-reader tests skip. Set `PICARD_EXE` when Picard is not installed in
`C:\Program Files\MusicBrainz Picard`.

To reload the plugin after a code change, disable and enable it in **Options > Plugins**,
or restart Picard.

## License

GPL-2.0-or-later, the same as Picard. See [LICENSE](LICENSE).

The test fixtures in `tests/fixtures/` are hand-made pages with Shironet's HTML structure.
They contain no lyrics: the lyrics in them are placeholders. The cache and the worker store
lyrics only on your own computer, for personal use.
