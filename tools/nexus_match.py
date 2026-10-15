"""
Find Nexus mods for name-only mods (uploaded lists have no Nexus IDs) by searching mod titles.

Uses the public Nexus Mods v2 GraphQL API, which needs no key. Results are cached per game and
normalized name in data/nexus_match.json, so each name is only ever searched once:

    {"domain": "<last game searched>",
     "games": {"<domain>": {"name:<normalized>": entry}}}

    entry = {"name": <mod name as listed>, "status": ..., "id": <modId or null>,
             "candidates": [{id, name, author, summary, picture, endorsements, category}], "checked": iso}

Statuses: "auto" (exactly one mod has this exact title), "suggest" (similar titles, the user
confirms), "none" (nothing found), and the user's own "accepted" / "rejected". A new search
only fills names that have no entry (and, with retry, "none" ones); user choices are never
overwritten.
"""

import json
import re
import threading
import time
import urllib.error
import urllib.request

import modlist_lib as lib

MATCHES = lib.DATA / "nexus_match.json"
API = "https://api.nexusmods.com/v2/graphql"
HEADERS = {"Content-Type": "application/json", "User-Agent": "modlist-atlas/2.0",
           "Application-Name": "modlist-atlas", "Application-Version": "2.0"}
DOMAIN_RE = re.compile(r"^[a-z0-9]{1,40}$")
BATCH = 12          # names per request; each name is two searches
PAUSE = 1.0         # seconds between requests, to stay polite without a key
MAX_CANDIDATES = 3
FIELDS = "nodes { modId name author summary pictureUrl endorsements category }"
# the lookup thread and the user's accept/reject both read-modify-write the cache
lock = threading.Lock()


class RateLimited(Exception):
    pass


def load() -> dict:
    data = lib.read_json(MATCHES, {})
    if not isinstance(data.get("games"), dict):
        data = {"domain": "", "games": {}}
    return data


def save(data: dict):
    lib.write_json(MATCHES, data, indent=None)


def trimmed(name: str) -> str:
    """'Vanilla Scripting Enhancements - BSA Version' -> 'Vanilla Scripting Enhancements'.
    Cuts at ' - ', '(', '[' or '_', then drops a trailing version number."""
    base = re.split(r"\s+[-–—]\s+|\s*[(\[]|_", name, maxsplit=1)[0]
    base = re.sub(r"\s+v?\d+(\.\d+)*[a-z]?$", "", base.strip(), flags=re.I).strip()
    return base if len(base) >= 3 else ""


def candidate(node: dict) -> dict:
    return {"id": node.get("modId"), "name": node.get("name") or "", "author": node.get("author") or "",
            "summary": " ".join(lib.strip_markup(node.get("summary") or "").split()),
            "picture": node.get("pictureUrl") or "", "endorsements": node.get("endorsements") or 0,
            "category": node.get("category") or ""}


def graphql(query: str, variables: dict) -> dict:
    req = urllib.request.Request(API, json.dumps({"query": query, "variables": variables}).encode(), HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise RateLimited() from e
        raise
    if body.get("errors") and not body.get("data"):
        raise RuntimeError(body["errors"][0].get("message", "Nexus API error"))
    return body.get("data") or {}


def search(domain: str, names: list, exact: bool, post) -> list:
    """For each name: (exact-title nodes, similar-title nodes) or, without exact, ([], similar)."""
    decl, parts, variables = ["$d: String!"], [], {"d": domain}
    for i, n in enumerate(names):
        decl.append(f"$n{i}: String!")
        variables[f"n{i}"] = n
        if exact:
            parts.append(f"e{i}: mods(filter: {{gameDomainName: {{value: $d}}, name: {{value: $n{i}, op: EQUALS}}}}, count: 5) {{ {FIELDS} }}")
        parts.append(f"s{i}: mods(filter: {{gameDomainName: {{value: $d}}, nameStemmed: {{value: $n{i}}}}}, count: 5, "
                     f"sort: {{endorsements: {{direction: DESC}}}}) {{ {FIELDS} }}")
    data = post(f"query Find({', '.join(decl)}) {{ {' '.join(parts)} }}", variables)
    nodes = lambda k: [candidate(x) for x in ((data.get(k) or {}).get("nodes") or []) if x.get("modId")]
    return [(nodes(f"e{i}") if exact else [], nodes(f"s{i}")) for i in range(len(names))]


def classify(name: str, exact: list, similar: list) -> dict:
    """Auto-match only when exactly one mod carries this exact title; anything else is a suggestion."""
    entry = {"name": name, "status": "none", "id": None, "candidates": [], "checked": lib.now_iso()}
    if len(exact) == 1:
        entry.update(status="auto", id=exact[0]["id"], candidates=exact)
        return entry
    seen, cands = set(), []
    for c in exact + similar:
        if c["id"] not in seen:
            seen.add(c["id"])
            cands.append(c)
    if cands:
        entry.update(status="suggest", candidates=cands[:MAX_CANDIDATES])
    return entry


def names_to_lookup() -> dict:
    """{normalized name: name} for every name-only mod in every list, except names another list
    already knows a Nexus ID for (the app borrows those)."""
    known, wanted = set(), {}
    for info in lib.read_json(lib.LISTS / "index.json", []):
        for m in lib.read_json(lib.LISTS / info["name"] / "mods.json", []):
            k = lib.name_key(m["name"])
            if m["key"].startswith("name:"):
                wanted.setdefault(k, m["name"])
            else:
                known.add(k)
    return {k: n for k, n in wanted.items() if k not in known and k != "name:"}


def pending(domain: str, retry: bool = False) -> dict:
    cached = load()["games"].get(domain, {})
    return {k: n for k, n in names_to_lookup().items()
            if k not in cached or (retry and cached[k].get("status") == "none")}


def run(domain: str, retry: bool = False, progress=None, should_stop=lambda: False, post=None, pause=None):
    """Search Nexus for every pending name, saving after each batch so a stop loses nothing.
    progress(done, total, counts) is called after each batch."""
    post = post or graphql
    pause = PAUSE if pause is None else pause
    todo = list(pending(domain, retry).items())
    counts = {"auto": 0, "suggest": 0, "none": 0}
    done = 0
    for start in range(0, len(todo), BATCH):
        if should_stop():
            break
        batch = todo[start:start + BATCH]
        results = search(domain, [n for _, n in batch], exact=True, post=post)
        entries = {k: classify(n, *res) for (k, n), res in zip(batch, results)}
        # nothing similar under the full name: try the base name ("X - BSA Version" -> "X"), as suggestions only
        retry_names = [(k, entries[k]["name"], trimmed(entries[k]["name"])) for k in entries
                       if entries[k]["status"] == "none"]
        retry_names = [(k, n, t) for k, n, t in retry_names if t and t.lower() != n.lower()]
        if retry_names:
            time.sleep(pause)
            for (k, n, _), (_, similar) in zip(retry_names, search(domain, [t for _, _, t in retry_names], exact=False, post=post)):
                if similar:
                    entries[k].update(status="suggest", candidates=similar[:MAX_CANDIDATES])
        with lock:
            data = load()  # re-read: the user may have accepted or rejected something meanwhile
            game = data["games"].setdefault(domain, {})
            for k, e in entries.items():
                if game.get(k, {}).get("status") not in ("accepted", "rejected"):
                    game[k] = e
                    counts[e["status"]] += 1
            data["domain"] = domain
            save(data)
        done += len(batch)
        if progress:
            progress(done, len(todo), counts)
        if start + BATCH < len(todo):
            time.sleep(pause)
    return counts


def set_status(domain: str, key: str, action: str, mod_id=None) -> dict:
    """The user's call on one name: accept a candidate, reject them all, or reset to suggestions."""
    with lock:
        data = load()
        entry = data["games"].get(domain, {}).get(key)
        if not entry:
            raise KeyError(key)
        if action == "accept":
            if not any(c["id"] == mod_id for c in entry.get("candidates", [])):
                raise ValueError("Not one of the suggested mods.")
            entry.update(status="accepted", id=mod_id)
        elif action == "reject":
            entry.update(status="rejected", id=None)
        elif action == "reset":
            entry.update(status="suggest" if entry.get("candidates") else "none", id=None)
        else:
            raise ValueError("Unknown action.")
        save(data)
        return entry
