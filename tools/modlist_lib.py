"""Shared helpers for exporting/importing modlists into lists/<name>/."""

import configparser
import csv
import html
import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent  # the tool's code
# Where user data lives (lists/, plan/, data/). Defaults to the repo folder; ATLAS_HOME
# moves it elsewhere (the tests point it at a temporary folder).
HOME = Path(os.environ.get("ATLAS_HOME") or REPO).resolve()
LISTS = HOME / "lists"
DATA = HOME / "data"
PLAN = HOME / "plan"
DECISIONS = PLAN / "decisions.json"
NEXUS_CACHE = DATA / "nexus_cache.json"
DESCRIPTIONS = DATA / "descriptions.json"
LOCAL_SOURCES = HOME / ".lists.local.json"  # machine-specific: list name -> MO2 path/profile

NAME_PATTERN = r"^[a-z0-9][a-z0-9._-]{0,40}$"
NAME_RE = re.compile(NAME_PATTERN)
# Windows reserved device names can't be folder names
RESERVED_NAMES = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(10)), *(f"lpt{i}" for i in range(10))}
# MO2's game short name (gameName in each mod's meta.ini) -> Nexus Mods game domain.
# Games not listed fall back to the short name in lowercase, which matches Nexus for most games.
GAME_DOMAINS = {
    "Skyrim": "skyrim", "SkyrimSE": "skyrimspecialedition", "SkyrimVR": "skyrimspecialedition",
    "Enderal": "enderal", "EnderalSE": "enderalspecialedition",
    "Morrowind": "morrowind", "Oblivion": "oblivion",
    "Fallout3": "fallout3", "FalloutNV": "newvegas", "TTW": "newvegas",
    "Fallout4": "fallout4", "Fallout4VR": "fallout4", "Starfield": "starfield",
    "Cyberpunk2077": "cyberpunk2077", "BaldursGate3": "baldursgate3", "Witcher3": "witcher3",
}
# MO2's display name (gameName in ModOrganizer.ini) -> short name; used when a mod has no gameName
GAME_DISPLAY_NAMES = {
    "Skyrim": "Skyrim", "Skyrim Special Edition": "SkyrimSE", "Skyrim VR": "SkyrimVR",
    "Enderal": "Enderal", "Enderal Special Edition": "EnderalSE",
    "Morrowind": "Morrowind", "Oblivion": "Oblivion",
    "Fallout 3": "Fallout3", "New Vegas": "FalloutNV", "TTW": "TTW",
    "Fallout 4": "Fallout4", "Fallout 4 VR": "Fallout4VR", "Starfield": "Starfield",
    "Cyberpunk 2077": "Cyberpunk2077", "Baldur's Gate 3": "BaldursGate3", "The Witcher 3": "Witcher3",
}
SUMMARY_MAX = 220
# requirement/installation boilerplate that makes a poor summary
SKIP_LINE = re.compile(
    r"^(skse|requires?|requirements?|install|installation|download|"
    r"compatib|credits?|changelog|permissions?|update|note:|version|"
    r"\(?(se|ae|vr)\b)", re.I)
UNSORTED = "(Top / unsorted)"

# Profile files worth keeping (no saves, no BethINI backups/cache): MO2's text files, plus any
# .ini in the profile folder: MO2's own (settings.ini) and the game's (Skyrim.ini, Fallout4Prefs.ini, …)
PROFILE_FILES = ["modlist.txt", "plugins.txt", "loadorder.txt", "lockedorder.txt", "archives.txt"]
PROFILE_INI_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,80}\.ini$")


def profile_file_name(name: str):
    """Canonical name if `name` is a profile file we keep, else None. Never contains a path."""
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    for f in PROFILE_FILES:
        if base.lower() == f:
            return f
    return base if PROFILE_INI_RE.match(base) else None
# absolute Windows/UNC paths in INI values are machine-specific
# INI keys that identify the machine (graphics adapter); the game re-detects them when blank
INI_MACHINE_KEYS = re.compile(r"^(\s*sD3DDevice\s*=)[^\r\n]*", re.M | re.I)
INI_PATH_VALUE = re.compile(r"^(\s*[^;#\[=\r\n][^=\r\n]*=)[ \t]*(?:[A-Za-z]:[\\/]|\\\\)[^\r\n]*", re.M)


# ---------------------------------------------------------------- config

def load_dotenv(path: Path = REPO / ".env"):
    """Minimal .env reader: KEY=value lines; real environment variables win."""
    if not path.exists():
        return
    for line in path.read_text("utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        if value:
            os.environ.setdefault(key.strip(), value)


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9._-]+", "-", s.lower()).strip("-")[:40] or "list"


def valid_name(name: str) -> bool:
    return bool(NAME_RE.match(name)) and name.split(".")[0] not in RESERVED_NAMES


NAME_ERROR = "Name: lowercase letters, digits, '.', '_' or '-' (max 41 chars, not a Windows device name)."


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class CorruptFile(Exception):
    """A JSON file exists but can't be parsed; callers must not overwrite it."""


def read_json(path: Path, default, strict: bool = False):
    """Parse a JSON file. Missing -> default. Unparseable -> default, or CorruptFile when strict."""
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return default
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        if strict:
            raise CorruptFile(f"{path} is not valid JSON ({e}); fix or remove it.") from e
        return default


def write_json(path: Path, data, indent=1):
    """Atomic write: a crash mid-write leaves the previous file intact."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=indent, ensure_ascii=False, sort_keys=True), "utf-8")
    os.replace(tmp, path)


def csv_safe(value):
    """Stop spreadsheet apps from running cell text as a formula (CSV injection)."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def redact_ini(text: str) -> str:
    """Blank out values that are absolute paths (e.g. a screenshot folder on F:)."""
    text = INI_PATH_VALUE.sub(r"\1", text)
    return INI_MACHINE_KEYS.sub(r"\1", text)


def clear_profile_dir(profile_dir: Path):
    """Remove previously copied profile files so a re-snapshot doesn't keep stale ones."""
    if profile_dir.is_dir():
        for old in profile_dir.iterdir():
            if old.is_file():
                old.unlink()


def write_profile_file(out_dir: Path, name: str, text: str):
    """Store one profile file, redacting machine-specific paths from INIs."""
    if name.lower().endswith(".ini"):
        text = redact_ini(text)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / name).write_text(text, "utf-8", newline="")


# ---------------------------------------------------------------- MO2 parsing

def read_meta(path: Path) -> dict:
    cp = configparser.RawConfigParser(strict=False, interpolation=None)
    cp.optionxform = str
    try:
        cp.read(path, encoding="utf-8")
    except (configparser.Error, UnicodeDecodeError):
        cp.read(path, encoding="latin-1")
    return dict(cp["General"]) if cp.has_section("General") else {}


def unquote_ini(v: str) -> str:
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] == '"':
        v = v[1:-1]
    return v.replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")


def clean_description(raw: str) -> str:
    """Nexus description as BBCode text (HTML line breaks turned into newlines)."""
    text = unquote_ini(raw)
    text = re.sub(r"<br\s*/?>\s*\n?", "\n", text, flags=re.I)
    return text.strip()


def strip_markup(text: str) -> str:
    text = unquote_ini(text)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\[(img|youtube|url=[^\]]*\]\s*\[img)[^\]]*\].*?\[/(img|youtube)\]", "", text, flags=re.I | re.S)
    text = re.sub(r"\[/?[a-zA-Z*]+(=[^\]]*)?\]", "", text)
    return html.unescape(text)


def derive_summary(desc: str) -> str:
    """First meaningful paragraph of the cached Nexus description."""
    if not desc:
        return ""
    for para in re.split(r"\n", strip_markup(desc)):
        p = " ".join(para.split())
        # skip headings / tiny lines and requirement boilerplate
        if len(p) < 40 or SKIP_LINE.match(p):
            continue
        if len(p) > SUMMARY_MAX:
            cut = p[:SUMMARY_MAX]
            end = max(cut.rfind(". "), cut.rfind("! "))
            p = cut[: end + 1] if end > 80 else cut.rsplit(" ", 1)[0] + "…"
        return p
    return ""


def read_categories(mo2: Path):
    """Map Nexus category id -> name, and MO2 category id -> name."""
    by_nexus, by_mo2 = {}, {}
    cats = mo2 / "categories.dat"
    if cats.exists():
        for line in cats.read_text("utf-8", errors="replace").splitlines():
            parts = line.split("|")
            if len(parts) >= 2:
                by_mo2[parts[0]] = parts[1]
    nexmap = mo2 / "nexuscatmap.dat"
    if nexmap.exists():
        for line in nexmap.read_text("utf-8", errors="replace").splitlines():
            parts = line.split("|")
            if len(parts) >= 3 and parts[0] in by_mo2:
                by_nexus[parts[2]] = by_mo2[parts[0]]
    return by_nexus, by_mo2


def nexus_domain(game: str) -> str:
    """Nexus game domain for an MO2 game short name ('' when unknown)."""
    if not game:
        return ""
    return GAME_DOMAINS.get(game) or re.sub(r"[^a-z0-9]", "", game.lower())


def instance_game(mo2: Path) -> str:
    """The MO2 instance's game as a short name, from ModOrganizer.ini (fallback for mods without one)."""
    cp = configparser.RawConfigParser(strict=False, interpolation=None)
    try:
        cp.read(mo2 / "ModOrganizer.ini", encoding="utf-8")
    except (configparser.Error, UnicodeDecodeError):
        return ""
    display = cp.get("General", "gameName", fallback="").strip()
    if display.startswith("@ByteArray(") and display.endswith(")"):
        display = display[len("@ByteArray("):-1]
    return GAME_DISPLAY_NAMES.get(display) or display.replace(" ", "")


def name_key(name: str) -> str:
    return "name:" + re.sub(r"[^a-z0-9]+", "", name.lower())


def parse_modlist(lines, display_order=False):
    """Yield (flag, name, section) in MO2 left-pane order.

    MO2 writes modlist.txt highest-priority first; pass display_order=True when
    the lines are already in left-pane order (as some modlist websites show them)."""
    entries = [l.rstrip("\r") for l in lines if l.strip() and not l.startswith("#")]
    if not display_order:
        entries = entries[::-1]
    section = UNSORTED
    for line in entries:
        flag, name = line[0], line[1:]
        if flag == "*":  # DLC / Creation Club, not managed by MO2
            continue
        if name.endswith("_separator"):
            section = name[: -len("_separator")]
            yield "sep", section, section
            continue
        yield flag, name, section


# ---------------------------------------------------------------- Nexus API

def fetch_nexus(mods, api_key: str):
    """Fill data/nexus_cache.json for mods not fetched yet. Returns the cache."""
    cache = read_json(NEXUS_CACHE, {})
    todo, seen = [], set()
    for m in mods:
        if m["nexus_id"] and m["key"] not in cache and m["key"] not in seen:
            seen.add(m["key"])
            todo.append(m)
    print(f"Nexus API: {len(todo)} mods to fetch ({len(cache)} cached)")
    for i, m in enumerate(todo, 1):
        url = f"https://api.nexusmods.com/v1/games/{m['domain']}/mods/{m['nexus_id']}.json"
        req = urllib.request.Request(url, headers={
            "apikey": api_key, "accept": "application/json",
            "Application-Name": "modlist-atlas", "Application-Version": "2.0",
        })
        remaining = None
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.load(r)
                remaining = r.headers.get("x-rl-hourly-remaining")
            cache[m["key"]] = {
                "name": data.get("name"),
                "summary": " ".join(strip_markup(data.get("summary") or "").split()),
                "author": data.get("author"),
                "picture": data.get("picture_url"),
                "endorsements": data.get("endorsement_count"),
                "updated": data.get("updated_time"),
                "available": data.get("available", True),
            }
        except urllib.error.HTTPError as e:
            print(f"  ! {m['name']} ({m['nexus_id']}): HTTP {e.code}")
            if e.code == 429:
                print("  Rate limited; stopping. Run again later to continue.")
                break
            if e.code in (401, 403) and i == 1:
                print("  API key rejected; skipping Nexus lookups.")
                break
            if e.code in (403, 404):  # hidden/removed mod: remember it
                cache[m["key"]] = {"summary": "", "available": False}
        except Exception as e:  # network hiccup: skip, retry next run
            print(f"  ! {m['name']}: {e}")
        if i % 25 == 0:
            print(f"  {i}/{len(todo)}  (hourly remaining: {remaining})", flush=True)
            write_json(NEXUS_CACHE, cache)
        time.sleep(0.25)
    write_json(NEXUS_CACHE, cache)
    return cache


def apply_nexus_cache(mods):
    cache = read_json(NEXUS_CACHE, {})
    for m in mods:
        c = cache.get(m["key"])
        if not c:
            continue
        if c.get("summary"):
            m["summary"] = c["summary"]
            m["summary_source"] = "nexus"
        for f in ("author", "picture", "endorsements"):
            if c.get(f):
                m[f] = c[f]
        if c.get("available") is False:
            m["unavailable"] = True


# ---------------------------------------------------------------- outputs

def md_escape(s: str) -> str:
    return (s or "").replace("|", "\\|").replace("\n", " ")


def anchor(s: str) -> str:
    return re.sub(r"[^\w\- ]", "", s.lower()).strip().replace(" ", "-")


def mod_title(m) -> str:
    title = md_escape(m["name"])
    title = f"[{title}]({m['url']})" if m.get("url") else title
    return title if m["enabled"] else f"~~{title}~~"


def mod_desc(m) -> str:
    desc = md_escape(m.get("summary", ""))
    if m.get("notes"):
        desc += f"<br>📝 _{md_escape(m['notes'])}_"
    return desc


def write_list(out: Path, info: dict, mods: list, sections: list, plugins: list):
    """Write mods.json/csv, MODLIST.md, MODLIST_BY_CATEGORY.md, LOADORDER.md and info.json."""
    out.mkdir(parents=True, exist_ok=True)
    title = info.get("title") or info["name"]
    enabled = sum(m["enabled"] for m in mods)
    info.update({"mods": len(mods), "enabled": enabled, "plugins": len(plugins),
                 "active_plugins": sum(e for e, _ in plugins), "sections": len(sections)})

    write_json(out / "mods.json", mods, indent=None)
    cols = ["priority", "section", "category", "name", "enabled", "version", "nexus_id", "url", "summary", "notes"]
    with open(out / "mods.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows({k: csv_safe(v) for k, v in m.items()} for m in mods)

    head = (f"**{len(mods)} mods** ({enabled} enabled, {len(mods) - enabled} disabled) · "
            f"{info.get('source_label', '')} · generated by `tools/`")

    # MODLIST.md: MO2 order, grouped by separator
    out_md = [f"# {title}", "", head, "",
              "Order matches Mod Organizer 2's left pane (top = lowest priority, bottom wins conflicts). "
              "~~Struck-through~~ mods are disabled. See also [by category](MODLIST_BY_CATEGORY.md) "
              "and [load order](LOADORDER.md).", "", "## Sections", ""]
    for s in sections:
        if s["mods"] or s["name"] != UNSORTED:
            on = sum(m["enabled"] for m in s["mods"])
            out_md.append(f"- [{s['name']}](#{anchor(s['name'])}) — {on}/{len(s['mods'])}")
    out_md.append("")
    for s in sections:
        if not s["mods"] and s["name"] == UNSORTED:
            continue
        out_md += [f"## {s['name']}", ""]
        if not s["mods"]:
            out_md += ["_empty_", ""]
            continue
        out_md += ["| # | Mod | Version | Description |", "|---:|---|---|---|"]
        for m in s["mods"]:
            out_md.append(f"| {m['priority']} | {mod_title(m)} | {md_escape(m.get('version'))} | {mod_desc(m)} |")
        out_md.append("")
    (out / "MODLIST.md").write_text("\n".join(out_md), "utf-8")

    # MODLIST_BY_CATEGORY.md: grouped by Nexus category, A-Z
    by_cat = {}
    for m in mods:
        by_cat.setdefault(m.get("category") or "Uncategorized", []).append(m)
    order = sorted(by_cat, key=lambda c: (c == "Uncategorized", c.lower()))
    out_md = [f"# {title} — by Category", "", head, "",
              "Grouped by the mod's Nexus category (falls back to its MO2 category), sorted A–Z. "
              "**#** is the MO2 priority and **Separator** is where it sits in [MODLIST.md](MODLIST.md). "
              "~~Struck-through~~ mods are disabled.", "", "## Categories", ""]
    for c in order:
        on = sum(m["enabled"] for m in by_cat[c])
        out_md.append(f"- [{c}](#{anchor(c)}) — {on}/{len(by_cat[c])}")
    out_md.append("")
    for c in order:
        out_md += [f"## {c}", "", "| Mod | Separator | # | Description |", "|---|---|---:|---|"]
        for m in sorted(by_cat[c], key=lambda m: m["name"].lower()):
            out_md.append(f"| {mod_title(m)} | {md_escape(m['section'])} | {m['priority']} | {mod_desc(m)} |")
        out_md.append("")
    (out / "MODLIST_BY_CATEGORY.md").write_text("\n".join(out_md), "utf-8")

    # LOADORDER.md
    lo = [f"# {title} — Plugin Load Order", "",
          f"{info['active_plugins']} active of {len(plugins)} plugins (official masters/CC are implicit).", "",
          "| # | Plugin | Active |", "|---:|---|:---:|"]
    for i, (e, p) in enumerate(plugins):
        lo.append(f"| {i} | {md_escape(p)} | {'✔' if e else ''} |")
    (out / "LOADORDER.md").write_text("\n".join(lo) + "\n", "utf-8")

    # keep the frozen flag across re-exports
    old = read_json(out / "info.json", {})
    if old.get("frozen"):
        info["frozen"] = True
    write_json(out / "info.json", info)
    rebuild_index()


def parse_plugins(lines):
    plugins = []
    for l in lines:
        l = l.rstrip("\r")
        if not l or l.startswith("#"):
            continue
        plugins.append((l.startswith("*"), l.lstrip("*")))
    return plugins


def rebuild_index():
    """lists/index.json: summary of every list, read by the web app."""
    items = []
    for info_path in sorted(LISTS.glob("*/info.json")):
        info = read_json(info_path, None)
        if info:
            items.append(info)
    items.sort(key=lambda i: (i.get("order", 50), i["name"]))
    write_json(LISTS / "index.json", items, indent=1)


def build_text_list(name: str, files: dict, info: dict) -> dict:
    """Create lists/<name>/ from MO2 text files only (no mods folder), e.g. uploaded profile files.

    files maps profile file names (see PROFILE_FILES) to their text."""
    if "modlist.txt" not in files:
        raise ValueError("modlist.txt is required")
    out = LISTS / name
    clear_profile_dir(out / "profile")
    for fname, text in files.items():
        write_profile_file(out / "profile", fname, text)

    lines = files["modlist.txt"].splitlines()
    # MO2 writes highest priority first with its header comment on top; some sites
    # show it in left-pane order with the header last (a list copied from such a site)
    content = [l for l in lines if l.strip()]
    display_order = bool(content) and not content[0].startswith("#") and content[-1].startswith("#")
    mods, sections = [], [{"name": UNSORTED, "mods": []}]
    for flag, mod_name, section in parse_modlist(lines, display_order=display_order):
        if flag == "sep":
            sections.append({"name": mod_name, "mods": []})
            continue
        m = {"priority": len(mods), "name": mod_name, "enabled": flag == "+", "section": section,
             "category": "", "version": "", "nexus_id": "", "domain": "", "url": "",
             "key": name_key(mod_name), "notes": "", "summary": "", "summary_source": ""}
        mods.append(m)
        sections[-1]["mods"].append(m)
    info = {"name": name, "generated": now_iso(), **info}
    write_list(out, info, mods, sections, parse_plugins(files.get("plugins.txt", "").splitlines()))
    return info


def merge_descriptions(new: dict):
    if not new:
        return
    store = read_json(DESCRIPTIONS, {})
    store.update(new)
    write_json(DESCRIPTIONS, store, indent=None)
