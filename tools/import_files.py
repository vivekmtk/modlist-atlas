"""
Import a modlist from MO2 profile files when the MO2 install itself isn't available.

    python tools/import_files.py <profile folder | profile .zip | files...> --name friend --title "Friend's list" --game skyrimspecialedition

Accepts a profile folder, a .zip of one, or loose files. modlist.txt is required;
plugins.txt, loadorder.txt and the INIs are picked up when present. Without the
mods folder there are no Nexus IDs, so mods are matched to your other lists by name.
"""

import argparse
import io
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import modlist_lib as lib  # noqa: E402

MAX_FILE = 5_000_000


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def files_from_zip(data: bytes) -> dict:
    """Profile files from the folder in the zip that holds modlist.txt (the shallowest one if
    there are several). Only that folder is read, so mods' own meta.ini files are never picked up."""
    out = {}
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        entries = [(i, i.filename.replace("\\", "/")) for i in z.infolist() if not i.is_dir()]
        modlists = sorted((p for _, p in entries if p.rsplit("/", 1)[-1].lower() == "modlist.txt"),
                          key=lambda p: p.count("/"))
        if not modlists:
            return out
        folder = modlists[0].rsplit("/", 1)[0] if "/" in modlists[0] else ""
        for info, path in entries:
            parent, _, base = path.rpartition("/")
            fname = lib.profile_file_name(base)
            if parent == folder and fname and fname not in out and info.file_size <= MAX_FILE:
                out[fname] = _decode(z.read(info))
    return out


def collect(named: dict) -> dict:
    """{filename: bytes} from an upload or disk -> {profile file name: text}. Zips are unpacked."""
    out = {}
    for fname, data in named.items():
        if fname.lower().endswith(".zip"):
            for k, v in files_from_zip(data).items():
                out.setdefault(k, v)
            continue
        base = lib.profile_file_name(fname)
        if base and len(data) <= MAX_FILE:
            out.setdefault(base, _decode(data))
    return out


def import_files(named: dict, name: str, title: str = "", origin: str = "", game: str = "") -> dict:
    if not lib.valid_name(name):
        raise ValueError(lib.NAME_ERROR)
    if game and not lib.GAME_RE.match(game):
        raise ValueError("Game: the Nexus game name from its URL, e.g. skyrimspecialedition.")
    files = collect(named)
    if "modlist.txt" not in files:
        raise ValueError("No modlist.txt found. Add the profile's modlist.txt (or a folder/zip containing it).")
    return lib.build_text_list(name, files, {
        "title": title or name,
        "source": "upload",
        "game": game,  # uploads have no Nexus IDs to tell; '' fits a session for any game
        "source_label": "Uploaded profile files" + (f" ({origin})" if origin else ""),
        "uploaded_files": sorted(files),
    })


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("paths", nargs="+", type=Path, help="profile folder, .zip, or individual files")
    ap.add_argument("--name", required=True, help="snapshot name, saved to lists/<name>/")
    ap.add_argument("--title", default="", help="display title")
    ap.add_argument("--game", default="", help="Nexus game name from its URL, e.g. skyrimspecialedition")
    args = ap.parse_args()
    named = {}
    for p in args.paths:
        if p.is_dir():
            for f in p.iterdir():
                if f.is_file() and lib.profile_file_name(f.name):
                    named[f.name] = f.read_bytes()
        elif p.is_file():
            named[p.name] = p.read_bytes()
        else:
            sys.exit(f"Not found: {p}")
    try:
        info = import_files(named, args.name, args.title, game=args.game)
    except (ValueError, zipfile.BadZipFile) as e:
        sys.exit(str(e))
    print(f"Imported '{info['name']}': {info['mods']} mods in {info['sections']} sections "
          f"from {', '.join(info['uploaded_files'])}")


if __name__ == "__main__":
    main()
