# Shironet Lyrics for MusicBrainz Picard

A plugin for [MusicBrainz Picard](https://picard.musicbrainz.org/) 3 that fills the
**Lyrics** tag of Hebrew songs from [Shironet](https://shironet.mako.co.il/), with a
lyrics server that keeps the cache and does the fetching.

## How it works

Two parts:

- **The lyrics server** (`server/`, Node). It owns the lyrics cache (SQLite), the matching
  rules, and a queue of songs to fetch. It fetches from Shironet with a real, visible
  Chrome, slowly and politely, and keeps going in the background.
- **The Picard plugin** (Python, in this folder). It reads tags, asks the server for
  lyrics, sends the server the lyrics your files already have, and writes the Lyrics tag.
  It never talks to Shironet itself.

Shironet is behind a bot manager (Radware): plain HTTP clients and headless browsers are
blocked, a visible browser gets through. That is why fetching lives in the server.

## Features

- **Lyrics on match.** When Picard matches a file without lyrics to a track, the plugin
  asks the server. A cached song fills the tag at once; any other Hebrew song is queued,
  ahead of songs queued by folder scans.
- **Lookup lyrics.** Right-click files, tracks, albums or clusters > **Plugins > Lookup
  lyrics in Shironet**. It fills missing lyrics, replaces lyrics that differ from the cached
  ones, queues the rest, and shows a summary. Run it again later to pick up queued songs.
  Nothing is written to disk until you save.
- **Your own lyrics feed the cache, in any language.** Every file Picard loads or saves
  sends its lyrics to the server. Lyrics you edit and save replace the cached ones;
  otherwise the cache keeps its lyrics when a file has different ones (a conflict, named in
  the log). A cached song fills the other versions of it too, English songs included.
- **Shironet for Hebrew songs only.** The server fetches a song only when its artist or its
  title has a Hebrew letter (either name: the file's own tags or the MusicBrainz name). A
  Hebrew artist with an English title counts; a language tag alone does not. Other songs
  get cached lyrics when the cache has them, and otherwise count as "Not Hebrew and not
  cached".
- **Loose cache key, exact Shironet match.** The cache key ignores niqqud, punctuation,
  direction marks, "feat." parts and version suffixes such as "(Live)" or "(בהופעה חיה)".
  Matching against Shironet stays exact on the title; a song reported "not found" usually
  has a title spelled differently from Shironet's — fix the title in the tags and look it
  up again.
- **Two ways to find a song.** The server searches Shironet by title (up to 5 result
  pages). When that finds nothing, it looks the artist up (exact name) and reads the
  artist's whole song list; a common title such as "בשבילך" is found there. Each artist's
  list is kept for 30 days, so the other songs of that artist cost no search at all.
- **Folder scan.** Tools > Shironet Lyrics > *Scan folder for lyrics...*, or
  `scripts/scan_folder.py` without Picard. A rescan reads only new and changed files.

Supported formats: MP3, FLAC, Ogg Vorbis, Opus, M4A/MP4, APE, WavPack, Musepack, WMA,
AIFF, WAV and DSF. Only unsynced lyrics are used.

## Install the plugin

Requires Picard 3.0 or later, and a running lyrics server (next section).

1. In Picard, click **Options > Options…**, then select the **Plugins** page.
2. Click **Install Plugin…**.
3. Install from one of these tabs:
   - **URL**: in **Git URL:**, type
     `https://github.com/yoavain/musicbrainz-picard-shironet-lyrics`.
   - **Local**: in **Directory:**, select a clone of this repository. Select **Load
     in-place (ignore git)** to load the folder as it is.
4. Click **Install…**. Picard warns that the plugin is not in the official registry.
5. Open **Options > Plugins > Shironet Lyrics** and set the **Lyrics server URL**
   (default `http://127.0.0.1:8735`). For a server on the network, also set the **Lyrics
   server token** (the server's `LYRICS_SERVER_TOKEN`).
6. Click **Help > View Log** and find `Shironet Lyrics: lyrics server <version> at <URL>`.
   A warning there means the plugin cannot reach the server, or the server refused the
   token.

The plugin keeps one small file of its own: `plugin-data/shironet-lyrics/scan-state.sqlite3`
under Picard's app-data folder (which files the folder scan already read; no lyrics).

## Run the server

Requires Node 26 or later and Chrome or Chromium (on this Windows machine: Chrome Dev).

```sh
cd server
npm ci
npm start
```

- The data folder is `%LOCALAPPDATA%\shironet-lyrics-server` on Windows and
  `$XDG_STATE_HOME/shironet-lyrics-server` on Linux; `LYRICS_SERVER_DATA_DIR` overrides it. It
  holds `lyrics.sqlite3`, `server.log` (rotated), an optional `config.json`, and Chrome's own
  folder `browser/` (managed by Chrome).
- It listens on `127.0.0.1:8735`. Ctrl+C stops it cleanly: the browser closes first.
- **On the network:** set `LYRICS_SERVER_TOKEN` (at least 24 printable ASCII characters,
  environment only, never in `config.json`) and a network `host`, and add the names
  clients use to `allowedHosts` (for example `"lyrics.example.home:8735"`). Every route
  except `GET /health` then needs `Authorization: Bearer <token>`. Without a token the
  server refuses a host that is not loopback.
- Settings: `config.json` in the data folder, every key optional (a wrong value stops the
  start with the key's name). The keys and their defaults are in `server/src/config.ts`;
  `browser.extraArgs` adds Chrome flags (check a new flag with `check-browser`).
  Environment overrides: `LYRICS_SERVER_DATA_DIR`, `LYRICS_SERVER_HOST`, `LYRICS_SERVER_PORT`,
  `LYRICS_SERVER_LOG_LEVEL`, `LYRICS_SERVER_CHROME`, `LYRICS_SERVER_NTFY_URL`; the token is
  `LYRICS_SERVER_TOKEN`. The server's own commands below use the token too.
- When Shironet shows a CAPTCHA, the server notifies you (Windows notification, or ntfy
  with `notify.ntfyUrl`) and waits for you to solve it in its browser window; otherwise it
  pauses for a cooldown (30 minutes, doubling).

Server commands (`node src/cli.ts <command>` in `server/`):

| Command | What it does |
|---|---|
| `serve` | Runs the server (what `npm start` does). |
| `status` | Queue, pace, browser, recent requests and calibration, from the running server or the database. |
| `requeue-not-found` | Searches songs not found again now instead of in a week; calibration samples that were not found are measured again. |
| `enqueue-calibration N` | Re-fetches N songs whose lyrics came from your files and compares (checks the parser). |
| `check-browser` | With the server stopped: the browser setup against live Shironet, plus a leak check. |
| `import <old cache>` | One-time move from the old Python plugin cache into an empty data folder. |
| `backup <file> [--db <database>]` | A consistent copy of the database (read-only; runs while the server runs). |
| `check-db [database]` | Integrity check and row counts (read-only). |

Run `backup` and `check-db` as the service's own user, or only while the service runs.
A read-only open creates the `-wal` and `-shm` files when they are missing; made by
another user, they can stop the service from writing its database.

At start the server migrates an older database: it copies it to `backups/` in the data
folder (the newest 5 copies stay), then runs the steps in `server/src/migrations.ts` in one
transaction. It refuses a database newer than its code. `GET /health` answers the version,
the deployed commit and the schema version.

**Production** runs the server in an LXC container on the LAN, which another repository
builds and manages. The requirements this server sets for the container (Chromium on a
virtual display — headless is blocked —, memory, data folder, service unit, health check)
are agreed with that repository.

Deploy from this machine (in `server/`, with a clean, committed `server/` folder):

| Command | What it does |
|---|---|
| `npm run deploy` | Uploads the committed `server/` as a new release, runs `npm ci`, switches `current` to it, restarts the service and waits for `/health` to report the commit. On failure it switches back. Keeps 3 releases. `-- --no-restart` installs without a restart; `-- --allow-destructive` is needed when a pending migration is marked destructive. |
| `npm run rollback` | Switches back to the release before the current one. A release older than a migration cannot open the migrated database; the pre-migration copy is in the data folder's `backups/`. |
| `npm run pull-prod -- <file> [--force]` | Copies the production database to a local file (never the other way). It refuses while the service is stopped. |

`LYRICS_SERVER_SSH_KEY` and `LYRICS_SERVER_DEPLOY_TARGET` override the SSH key and the
`user@host`. The first connection needs the container's host key in `known_hosts`: run
`ssh -i <key> <user@host> true` once and compare the fingerprint with the network
repository's record.

## Folder scan from the command line

```sh
python scripts/scan_folder.py "D:\Music" --server http://127.0.0.1:8735
```

The same scan as Picard's Tools menu: new and changed files are read; their lyrics go to
the server, and songs without lyrics are queued there. Unchanged files without lyrics are
asked for again from what the last scan recorded. It shares the scan state with the plugin
and prints a summary. Ctrl+C stops after the current file. For a server on the network,
set `LYRICS_SERVER_TOKEN` in the environment.

It needs `mutagen`. Without an installed `mutagen`, it loads the copy inside the installed
Picard. That works only when your Python has the same version as Picard's bundled Python
(3.14 for Picard 3.0). `--picard-exe` or `PICARD_EXE` points at a Picard installed
elsewhere.

## Import lyrics from a folder

```sh
python scripts/import_lyrics.py "D:\Music" --dry-run   # count only
python scripts/import_lyrics.py "D:\Music" --server http://127.0.0.1:8735
```

This is the reverse of the Plex export. It sends the lyrics that a folder's files already
have to the server, in any language, so the other versions of those songs get them too.

- Lyrics come from the tags. A file without lyrics in its tags uses its `.txt` or `.lrc`
  sidecar (UTF-8). A `.lrc` loses its time tags, because the cache keeps plain text.
- The cache keeps its own lyrics when a file has different ones. The script lists these
  conflicts after the summary: the first 20, or all of them with `--verbose`.
- Nothing is queued for Shironet; that is the folder scan's job.
- Every file is read on every run. The scan state is not used. A second run answers "same"
  for lyrics it sent before.
- Ctrl+C stops after the current file. For a server on the network, set
  `LYRICS_SERVER_TOKEN`. It needs `mutagen`, as the folder scan does.

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
  sidecars only; it does not use the server.
- A track that already has a `.lrc` or `.txt` is skipped without reading its tags.
  `--overwrite` re-exports it.
- Synced lyrics (ID3 `SYLT`) become `.lrc`; plain lyrics whose lines carry LRC time tags
  (`[01:23.45]`) become `.lrc` too; other lyrics become `.txt`.
- The text is the tag's text with LF newlines, minus a `heb||`-style prefix. `--clean` also
  removes a title-and-credits header and skips "instrumental" placeholders.
- `--verbose` lists every file written; otherwise the first 20 and the totals.

## Use with LRCLIB Lyrics (non-Hebrew songs)

This plugin covers Hebrew songs only. For other songs, it can run next to
**LRCLIB Lyrics**, which fetches synced and plain lyrics from [LRCLIB](https://lrclib.net).
The original [izaz4141/picard-lrclib](https://github.com/izaz4141/picard-lrclib) supports
Picard 2 only; the Picard 3 version is the fork
[Opt6/picard-lrclib](https://github.com/Opt6/picard-lrclib). The fork is not in the official
registry and has not been reviewed here.

To install it, follow the steps in [Install the plugin](#install-the-plugin) with the
**URL** tab and the Git URL `https://github.com/Opt6/picard-lrclib`.

Both plugins write the **Lyrics** tag when Picard matches a file. Shironet Lyrics fills it
only when the file has no lyrics. Which plugin wins on a Hebrew song depends on which one
runs first and on whether LRCLIB Lyrics replaces existing lyrics; check a matched Hebrew
album before you save it. LRCLIB Lyrics also creates and renames `.lrc` files, so
`scripts/export_lyrics.py` skips those tracks, and `scripts/import_lyrics.py` reads them
when the tags have no lyrics.

## Layout

Picard loads a plugin from the repository root, so the root holds `MANIFEST.toml` and an
`__init__.py` that re-exports `enable` and `disable` from `plugin/plugin.py`.

| Path | Contents |
|---|---|
| `plugin/` | The Picard plugin: hooks and actions (`plugin.py`), the server client, the folder scan and its state, the tag reader, the Plex export and the lyrics import |
| `scripts/` | Command-line tools: folder scan, lyrics import, Plex export, and `_bootstrap.py` (loads the plugin modules and Picard's bundled `mutagen` without Picard) |
| `tests/` | Python tests |
| `server/` | The lyrics server: `src/` (TypeScript, run directly by Node), `test/`, `test-browser/` (opt-in tests on real Chrome), `tools/` (deploy script), `DEPENDENCIES.md` (Snyk decisions) |

## Development

Python (from the repository root; nothing to install):

```sh
python -m unittest discover -s tests
```

The tests load the plugin modules without Picard and `mutagen` from the installed Picard;
when that fails, the tag-reader tests skip. Set `PICARD_EXE` when Picard is not installed in
`C:\Program Files\MusicBrainz Picard`. To reload the plugin after a code change, restart
Picard.

Server (in `server/`):

```sh
npm test               # unit tests
npm run typecheck      # tsc --noEmit
npm run test:browser   # opt-in: real Chrome on local fixture pages, no network
```

A schema change is a new step at the end of `MIGRATIONS` in `server/src/migrations.ts`
(never an edit of an earlier step), with `destructive: true` when it drops or rewrites
data.

Every new npm dependency is checked with Snyk first; the decisions are in
`server/DEPENDENCIES.md`.

## License

GPL-2.0-or-later, the same as Picard. See [LICENSE](LICENSE).

The test fixtures are hand-made pages with Shironet's HTML structure. They contain no
lyrics: the lyrics in them are placeholders. The cache stores lyrics only on your own
machines, for personal use.
