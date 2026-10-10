"""
Snapshot a Mod Organizer 2 profile into lists/<name>/.

READ-ONLY with respect to MO2: it only reads files from the MO2 instance and
writes into this repo. Run it any time the modlist changes:

    python tools/export_modlist.py                      # uses .env
    python tools/export_modlist.py --mo2 "<MO2 folder>" --profile "<profile>" --name wip

Configuration (a .env file in the repo root, an environment variable, or the
matching command-line flag; see .env.example):
    MO2_PATH       MO2 instance folder (contains mods/ and profiles/)  --mo2
    MO2_PROFILE    profile name, default "Default"                     --profile
    MO2_LIST_NAME  snapshot name, default: the profile name            --name
    NEXUS_API_KEY  optional; official Nexus summaries and thumbnails

Nexus results are cached in data/nexus_cache.json, so only new mods are
fetched on later runs. Without a key, a summary is derived from the Nexus
description MO2 already cached in each mod's meta.ini.
"""

import argparse
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import modlist_lib as lib  # noqa: E402

NOTE_GLOBS = ["*.md"]  # the user's own notes in the profile folder


def export(mo2: Path, profile: str, name: str, use_api: bool = True, freeze=None):
    mods_dir = mo2 / "mods"
    prof_dir = mo2 / "profiles" / profile
    if not lib.valid_name(name):
        raise ValueError(lib.NAME_ERROR)
    if not (prof_dir / "modlist.txt").exists():
        raise ValueError(f"modlist.txt not found in {prof_dir}")
    out = lib.LISTS / name

    # 1) copy profile files (read from MO2, write into lists/<name>/)
    lib.clear_profile_dir(out / "profile")
    (out / "profile").mkdir(parents=True, exist_ok=True)
    (out / "notes").mkdir(exist_ok=True)
    for src in sorted(prof_dir.iterdir()):
        fname = lib.profile_file_name(src.name) if src.is_file() else None
        if fname:
            lib.write_profile_file(out / "profile", fname, src.read_text("utf-8", errors="replace"))
    for g in NOTE_GLOBS:
        for src in prof_dir.glob(g):
            shutil.copy2(src, out / "notes" / src.name)
    if not any((out / "notes").iterdir()):
        (out / "notes").rmdir()

    # 2) parse modlist + each mod's meta.ini
    cats_nexus, cats_mo2 = lib.read_categories(mo2)
    default_game = lib.instance_game(mo2)
    lines = (prof_dir / "modlist.txt").read_text("utf-8").splitlines()
    mods, descriptions = [], {}
    sections = [{"name": lib.UNSORTED, "mods": []}]
    for flag, mod_name, section in lib.parse_modlist(lines):
        if flag == "sep":
            sections.append({"name": mod_name, "mods": []})
            continue
        meta = lib.read_meta(mods_dir / mod_name / "meta.ini")
        nexus_id = meta.get("modid", "0").strip()
        domain = lib.nexus_domain(meta.get("gameName", "").strip() or default_game)
        # a Nexus ID is only usable when we also know which game's Nexus section it belongs to
        nexus_id = nexus_id if nexus_id not in ("", "0", "-1") and domain else ""
        custom_url = meta.get("url", "").strip() if meta.get("hasCustomURL") == "true" else ""
        link = custom_url or (f"https://www.nexusmods.com/{domain}/mods/{nexus_id}" if nexus_id else "")
        # Nexus's own category first (same on every install), then the MO2 one
        mo2_cat = meta.get("category", "").strip('"').split(",")[0]
        category = (cats_nexus.get(meta.get("nexusCategory", "").strip())
                    or cats_mo2.get(mo2_cat) or "Uncategorized")
        key = f"{domain}/{nexus_id}" if nexus_id else lib.name_key(mod_name)
        raw_desc = meta.get("nexusDescription", "")
        if raw_desc and key not in descriptions:
            descriptions[key] = lib.clean_description(raw_desc)
        m = {
            "priority": len(mods),
            "name": mod_name,
            "enabled": flag == "+",
            "section": section,
            "category": category,
            "version": meta.get("version", "").strip(),
            "nexus_id": nexus_id,
            "domain": domain,
            "url": link,
            "key": key,
            "notes": lib.strip_markup(meta.get("notes", "")).strip(),
            "summary": lib.derive_summary(raw_desc),
            "summary_source": "description",
        }
        mods.append(m)
        sections[-1]["mods"].append(m)

    # 3) Nexus summaries/thumbnails (optional)
    api_key = os.environ.get("NEXUS_API_KEY")
    if api_key and use_api:
        lib.fetch_nexus(mods, api_key)
    lib.apply_nexus_cache(mods)
    lib.merge_descriptions(descriptions)

    # 4) outputs
    plugins = lib.parse_plugins((prof_dir / "plugins.txt").read_text("utf-8", errors="replace").splitlines()) \
        if (prof_dir / "plugins.txt").exists() else []
    info = {
        "name": name,
        "title": f"{name} — MO2 profile {profile}",
        "source": "mo2",
        "source_label": f"MO2 profile `{profile}`",
        "profile": profile,
        "generated": lib.now_iso(),
    }
    lib.write_list(out, info, mods, sections, plugins)
    if freeze is not None:
        info = lib.read_json(out / "info.json", {})
        info["frozen"] = freeze
        lib.write_json(out / "info.json", info)
        lib.rebuild_index()

    # remember where this list comes from (machine-specific, git-ignored)
    sources = lib.read_json(lib.LOCAL_SOURCES, {})
    sources[name] = {"mo2": str(mo2), "profile": profile}
    lib.write_json(lib.LOCAL_SOURCES, sources)

    with_nexus = sum(m["summary_source"] == "nexus" for m in mods)
    print(f"Exported '{name}': {len(mods)} mods in {len(sections)} sections, {len(plugins)} plugins -> {out}")
    print(f"Summaries: {with_nexus} from Nexus API, {len(mods) - with_nexus} derived from cached description.")


def main():
    lib.load_dotenv()
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--mo2", type=Path, default=os.environ.get("MO2_PATH"),
                    help="MO2 instance folder (default: $MO2_PATH)")
    ap.add_argument("--profile", default=os.environ.get("MO2_PROFILE", "Default"),
                    help="profile name (default: $MO2_PROFILE or Default)")
    ap.add_argument("--name", default=os.environ.get("MO2_LIST_NAME"),
                    help="snapshot name, saved to lists/<name>/ (default: $MO2_LIST_NAME or the profile name)")
    ap.add_argument("--no-api", action="store_true", help="never call the Nexus API")
    ap.add_argument("--freeze", action="store_true", default=None,
                    help="mark the list frozen (the web app asks before overwriting it)")
    ap.add_argument("--unfreeze", dest="freeze", action="store_false")
    args = ap.parse_args()
    if not args.mo2:
        sys.exit("Set MO2_PATH or pass --mo2 with your Mod Organizer 2 folder.")
    name = args.name or lib.slug(args.profile)
    try:
        export(args.mo2, args.profile, name, use_api=not args.no_api, freeze=args.freeze)
    except ValueError as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
