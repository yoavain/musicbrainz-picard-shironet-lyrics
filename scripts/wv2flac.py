"""Split a WavPack album image into per-track FLAC files.

Usage: wv2flac <file.wv | file.cue> [more files...] [-o OUT_DIR] [--force]

Accepts a plain .wv, a self-extracting .wv (WavPack data behind a Windows stub,
which is never run), an "ISO.WV" release (an ISO image that also plays as
WavPack), or a .cue (its .wv is looked up next to it or one folder up). Without
an explicit .cue, the CUE sheet comes from, in order: a .cue named after the .wv
(next to it or one subfolder down), the only .cue next to it, the .wv's embedded
Cuesheet tag. Without a CUE sheet the whole file becomes one FLAC. Tracks are
named "NN - Title.flac", or "NN.flac" when the CUE has no titles. Output goes
next to the source unless -o is given; a CUE titled "... [Disc N]" goes to a CDN
subfolder. Cover images (the ISO's cover scans, or pictures embedded in the .wv
tag) go to a Covers folder.

Needs ffmpeg/ffprobe on PATH and CUETools.Flake.exe (CUETools 2.2.6) for FLAC
encoding; ISO.WV releases also need 7-Zip.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CD_FRAMES_PER_SECOND = 75
INVALID_NAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".gif", ".bmp")
COVER_DIR_NAME = re.compile(r"cover|scan|artwork", re.I)
CODEC_EXT = {"mjpeg": ".jpg", "png": ".png", "gif": ".gif", "bmp": ".bmp"}
APE_TO_VORBIS = {"track": "TRACKNUMBER", "year": "DATE", "disc": "DISCNUMBER",
                 "album artist": "ALBUMARTIST", "album_artist": "ALBUMARTIST"}
# "[Disc 1]", "(CD 2)", or a trailing "- Disc 1" / "CD1".
DISC_IN_TITLE = re.compile(r"\s*(?:[\[(]\s*(?:disc|cd)\s*(\d+)\s*[\])]|[-:]?\s*\b(?:disc|cd)\s*(\d+)\s*$)", re.I)
FLAKE_DEFAULT = Path(r"C:\Dev-Tools\CUETools_2.2.6\CUETools.Flake.exe")


def find_flake():
    exe = shutil.which("CUETools.Flake")
    if exe:
        return exe
    if FLAKE_DEFAULT.exists():
        return str(FLAKE_DEFAULT)
    sys.exit(f"CUETools.Flake.exe not found (expected at {FLAKE_DEFAULT})")


def find_7z():
    exe = shutil.which("7z")
    if exe:
        return exe
    default = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "7-Zip" / "7z.exe"
    if default.exists():
        return str(default)
    sys.exit("7-Zip not found; needed to unpack ISO.WV releases")


def is_iso(path):
    # ISO 9660 primary volume descriptor: "CD001" at byte 0x8001.
    with open(path, "rb") as f:
        f.seek(0x8001)
        return f.read(5) == b"CD001"


def unpack_iso(path, dest):
    """Extract the audio, CUE and image files of an ISO.WV release; return the main .wv."""
    patterns = ["*.wv", "*.cue", "*.wvc"] + ["*" + ext for ext in IMAGE_EXTS]
    subprocess.run(
        [find_7z(), "x", "-tiso", "-y", "-bso0", "-bsp0", f"-o{dest}", str(path), *patterns, "-r"],
        check=True,
    )
    wvs = sorted(Path(dest).rglob("*.wv"), key=lambda p: p.stat().st_size, reverse=True)
    if not wvs:
        sys.exit(f"No .wv file inside ISO: {path}")
    return wvs[0]


def decode_text(data):
    for enc in ("utf-8-sig", "cp1255", "cp1252"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            pass
    return data.decode("latin-1")


def wavpack_offset(path):
    """Byte offset of the WavPack data: 0 normally, past the stub for a self-extracting .wv.

    A self-extracting .wv is a Windows program with the WavPack stream appended. It is
    never run; ffmpeg just reads from the first block header onwards.
    """
    with open(path, "rb") as f:
        head = f.read(1 << 20)
    if head[:4] == b"wvpk" or head[:2] != b"MZ":
        return 0
    i = head.find(b"wvpk")
    while i >= 0:
        if 0x402 <= int.from_bytes(head[i + 8:i + 10], "little") <= 0x410:
            return i
        i = head.find(b"wvpk", i + 1)
    return 0


def probe(path):
    offset = wavpack_offset(path)
    if offset:
        print(f"  Self-extracting .wv; reading WavPack data from byte {offset}")
    url = f"subfile,,start,{offset},end,0,,:{path}" if offset else str(path)
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", url],
        check=True, capture_output=True,
    ).stdout
    info = json.loads(out.decode("utf-8"))
    audio = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    if not audio:
        sys.exit(f"No audio stream in {path}")
    info["audio"] = audio[0]
    info["url"] = url  # what ffmpeg opens
    return info


def save_covers(info, iso_root, out_dir, force):
    """Write cover images to out_dir/Covers: ISO image files and pictures embedded in the .wv."""
    covers = out_dir / "Covers"
    saved = []

    def target(name):
        path = covers / name
        if path.exists() and not force:
            print(f"  Cover exists, skipped: {path.name}")
            return None
        covers.mkdir(parents=True, exist_ok=True)
        return path

    if iso_root:
        # Images at the ISO root or under a cover/scan/artwork folder; not release-info extras.
        root = Path(iso_root)
        for img in sorted(root.rglob("*")):
            if img.suffix.lower() not in IMAGE_EXTS:
                continue
            rel = img.relative_to(root)
            if len(rel.parts) > 1 and not any(COVER_DIR_NAME.search(p) for p in rel.parts[:-1]):
                continue
            path = target(safe_name("_".join(rel.parts[1:] if len(rel.parts) > 1 else rel.parts)))
            if path:
                shutil.copyfile(img, path)
                saved.append(path)

    pics = [s for s in info["streams"] if s.get("disposition", {}).get("attached_pic")]
    for n, s in enumerate(pics, 1):
        label = s.get("tags", {}).get("comment") or s.get("tags", {}).get("title") or f"cover_{n}"
        path = target(safe_name(label) + CODEC_EXT.get(s.get("codec_name"), ".jpg"))
        if path:
            subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", info["url"],
                 "-map", f"0:{s['index']}", "-c", "copy", "-f", "image2", str(path)],
                check=True,
            )
            saved.append(path)

    for path in saved:
        print(f"  Covers\\{path.name}")


def find_cue(wv, info):
    """Return CUE text: a .cue named after the .wv (next to it or one subfolder down),
    then the only .cue next to it, then the embedded tag."""
    dirs = [wv.parent] + sorted(p for p in wv.parent.iterdir() if p.is_dir())
    for d in dirs:
        for cue in (d / (wv.name + ".cue"), d / (wv.stem + ".cue")):
            if cue.exists():
                return decode_text(cue.read_bytes()), str(cue)
    cues = list(wv.parent.glob("*.cue"))
    if len(cues) == 1:
        return decode_text(cues[0].read_bytes()), str(cues[0])
    for key, value in info["format"].get("tags", {}).items():
        if key.lower() == "cuesheet":
            return value, "embedded tag"
    return None, None


def audio_for_cue(cue):
    """Find the .wv a CUE sheet belongs to: its FILE entry, or the same name as .wv,
    next to the CUE or in the parent folder."""
    m = re.search(r'^\s*FILE\s+"?(.*?)"?\s+\w+\s*$', decode_text(cue.read_bytes()), re.M | re.I)
    names = [cue.stem + ".wv"]
    if m:
        names = [m.group(1), Path(m.group(1)).stem + ".wv"] + names
    for d in (cue.parent, cue.parent.parent):
        for name in names:
            if (d / name).exists() and (d / name).suffix.lower() == ".wv":
                return d / name
    sys.exit(f"No .wv found for {cue} (tried {', '.join(names)} here and in the parent folder)")


def unquote(s):
    s = s.strip()
    return s[1:-1] if len(s) >= 2 and s[0] == s[-1] == '"' else s


def cue_time_to_frames(t):
    m, s, f = (int(x) for x in t.split(":"))
    return (m * 60 + s) * CD_FRAMES_PER_SECOND + f


def parse_cue(text):
    album = {}
    tracks = []
    files = 0
    for line in text.splitlines():
        parts = line.strip().split(None, 1)
        if not parts:
            continue
        cmd, rest = parts[0].upper(), parts[1] if len(parts) > 1 else ""
        target = tracks[-1] if tracks else album
        if cmd == "FILE":
            files += 1
        elif cmd == "CATALOG":
            album["catalog"] = rest.strip()
        elif cmd == "TRACK":
            tracks.append({"number": int(rest.split()[0])})
        elif cmd in ("TITLE", "PERFORMER", "SONGWRITER", "ISRC"):
            target[cmd.lower()] = unquote(rest)
        elif cmd == "REM":
            sub = rest.split(None, 1)
            if len(sub) == 2:
                target["rem_" + sub[0].lower()] = unquote(sub[1])
        elif cmd == "INDEX" and tracks:
            num, t = rest.split()
            tracks[-1]["index%02d" % int(num)] = cue_time_to_frames(t)
    if files > 1:
        sys.exit("CUE sheet references more than one FILE; only single-image CUEs are supported")
    if not tracks:
        sys.exit("CUE sheet has no tracks")
    return album, tracks


def apply_disc_number(album, fallback_name):
    """Take "[Disc N]" / "CD N" out of the album title into DISCNUMBER; return N or None."""
    if album.get("rem_discnumber"):
        return album["rem_discnumber"]
    for text in (album.get("title", ""), fallback_name):
        m = DISC_IN_TITLE.search(text)
        if m:
            n = m.group(1) or m.group(2)
            if album.get("title"):
                album["title"] = DISC_IN_TITLE.sub("", album["title"]).strip()
            album["rem_discnumber"] = n
            return n
    return None


def safe_name(s):
    s = INVALID_NAME_CHARS.sub("_", s).strip().rstrip(". ")
    return s or "_"


def track_tags(album, track, total):
    tags = {
        "TITLE": track.get("title"),
        "ARTIST": track.get("performer") or album.get("performer"),
        "ALBUM": album.get("title"),
        "ALBUMARTIST": album.get("performer"),
        "COMPOSER": track.get("songwriter") or album.get("songwriter"),
        "DATE": album.get("rem_date"),
        "GENRE": album.get("rem_genre"),
        "DISCNUMBER": album.get("rem_discnumber"),
        "TOTALDISCS": album.get("rem_totaldiscs"),
        "ISRC": track.get("isrc"),
        "BARCODE": album.get("catalog"),
        "TRACKNUMBER": str(track["number"]),
        "TRACKTOTAL": str(total),
    }
    return {k: v for k, v in tags.items() if v}


def pcm_codec(stream):
    if stream.get("sample_fmt", "").startswith("s16"):
        return "pcm_s16le"
    return "pcm_s%dle" % int(stream.get("bits_per_raw_sample") or 24)


def encode(info, audio_filter, tags, path):
    """Decode with ffmpeg (exact-sample trim) to a temp WAV, then encode it with Flake.

    ffmpeg's own FLAC output passes the decoder's 1 s frames through as oversized
    blocks and writes no SEEKTABLE, which breaks seeking in players. Flake writes
    standard 4096-sample blocks, a SEEKTABLE and verifies what it wrote. It only
    writes the SEEKTABLE when it knows the length up front, so it reads a sized
    WAV file, not a pipe.
    """
    with tempfile.TemporaryDirectory(prefix="wv2flac-") as tmp:
        wav = Path(tmp) / "track.wav"
        decode = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", info["url"], "-map", "0:a:0"]
        if audio_filter:
            decode += ["-af", audio_filter]
        decode += ["-map_metadata", "-1", "-c:a", pcm_codec(info["audio"]), str(wav)]
        subprocess.run(decode, check=True)

        flake = [find_flake(), "-8", "-q", "--force", "--verify", "-P", "8192"]
        for k, v in tags.items():
            flake += ["-T", f"{k}={v}"]
        subprocess.run(flake + ["-o", str(path), str(wav)], check=True)
    print(f"  {path.name}")


def split(wv, info, cue_text, out_dir, force):
    rate = int(info["audio"]["sample_rate"])
    album, tracks = parse_cue(cue_text)
    disc = apply_disc_number(album, wv.stem)
    if disc:
        out_dir = out_dir / f"CD{int(disc)}"
        print(f"  Disc {disc} -> {out_dir.name}\\")

    def to_samples(frames):
        return frames * rate // CD_FRAMES_PER_SECOND

    # Gaps (INDEX 00) are appended to the previous track; each track starts at its INDEX 01.
    starts = [to_samples(t["index01"]) for t in tracks]
    ends = starts[1:] + [None]
    segments = list(zip(tracks, starts, ends))
    if starts[0] > 0:
        # Hidden track / pregap before track 1 becomes track 00.
        segments.insert(0, ({"number": 0, "title": None}, 0, starts[0]))

    total = len(tracks)
    has_titles = any(t.get("title") for t in tracks)
    outputs = []
    for track, start, end in segments:
        name = "%02d" % track["number"]
        if has_titles and track.get("title"):
            name += " - " + safe_name(track["title"])
        outputs.append((track, start, end, out_dir / (name + ".flac")))

    existing = [o[3] for o in outputs if o[3].exists()]
    if existing and not force:
        sys.exit("Output exists (use --force to overwrite):\n  " + "\n  ".join(map(str, existing)))

    out_dir.mkdir(parents=True, exist_ok=True)
    for track, start, end, path in outputs:
        trim = f"atrim=start_sample={start}" + (f":end_sample={end}" if end is not None else "")
        tags = track_tags(album, track, total) if track["number"] > 0 else {}
        encode(info, f"{trim},asetpts=PTS-STARTPTS", tags, path)


def convert_whole(wv, info, out_dir, name, force):
    path = out_dir / (Path(name).stem + ".flac")
    if path.exists() and not force:
        sys.exit(f"Output exists (use --force to overwrite): {path}")
    out_dir.mkdir(parents=True, exist_ok=True)
    # Keep the source tags, minus the bulky image-only ones that do not belong on a single track.
    tags = {APE_TO_VORBIS.get(k.lower(), k.upper()): v for k, v in info["format"].get("tags", {}).items()
            if k.lower() not in ("cuesheet", "log", "encoder")}
    encode(info, None, tags, path)


def process(src, out_dir, force):
    src = Path(src).resolve()
    print(src)
    cue = None
    if src.suffix.lower() == ".cue":
        cue = src
        src = audio_for_cue(cue)
        print(f"  Audio: {src}")
    out_dir = Path(out_dir).resolve() if out_dir else src.parent
    tmp = None
    try:
        wv = src
        if is_iso(src):
            print("  ISO.WV release; unpacking inner .wv, .cue and images")
            tmp = tempfile.mkdtemp(prefix="wv2flac-")
            wv = unpack_iso(src, tmp)
        if wv.with_name(wv.name + "c").exists():
            print("  WARNING: .wvc correction file found; ffmpeg ignores it, so output is the lossy hybrid part only")
        info = probe(wv)
        if cue:
            cue_text, cue_src = decode_text(cue.read_bytes()), str(cue)
        else:
            cue_text, cue_src = find_cue(wv, info)
        if cue_text:
            print(f"  CUE: {cue_src}")
            split(wv, info, cue_text, out_dir, force)
        else:
            print("  No CUE sheet; converting as one file")
            convert_whole(wv, info, out_dir, wv.name, force)
        save_covers(info, tmp, out_dir, force)
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Split WavPack album images (incl. ISO.WV) into FLAC tracks.")
    ap.add_argument("files", nargs="+", help=".wv, .iso.wv or .cue files")
    ap.add_argument("-o", "--out-dir", help="output folder (default: next to each source)")
    ap.add_argument("--force", action="store_true", help="overwrite existing FLAC and cover files")
    args = ap.parse_args()
    for f in args.files:
        process(f, args.out_dir, args.force)


if __name__ == "__main__":
    main()
