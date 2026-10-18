"""
Local server for the Modlist Atlas web app, with snapshots, imports and decision saving.

    python tools/serve.py            # opens http://localhost:8000
    python tools/serve.py --port 8123 --no-browser

Listens on 127.0.0.1 only. Serves an allowlist of files (the app itself plus the
user's lists, descriptions and decisions) and a small JSON API used by the app:

    GET  /api/status                  local mode, defaults, list sources, change flags, shared rules
    GET  /api/profiles?mo2=<folder>   profile names found in an MO2 folder
    POST /api/snapshot                {mo2, profile, name, session?, details?, confirm}  -> runs export_modlist.py
                                      without Nexus; details: then fetches the list's Nexus details in the background
    POST /api/import                  {kind: "files", name, title, game, session?, files: [{name, data(base64)}], confirm}
    POST /api/decisions?session=<s>   {key: {decision?, note?, name?, name_key?}} -> plan/sessions/<s>/decisions.json
    POST /api/session/create          {title, game, from?}  -> a new session, empty or a copy of `from`
    POST /api/session/rename          {name, title}
    POST /api/session/delete          {name, confirm}  -> removes plan/sessions/<name>/ (never the last one)
    POST /api/session/setup           {name, setup}  -> the session's filters and view in the app
    POST /api/session/add-list        {session, name}  -> adds an existing list to the session
    POST /api/session/remove-list     {session, name, confirm}  -> takes a list out of the session;
                                      removes lists/<name>/ when no other session has it (decisions are kept)
    POST /api/freeze                  {name, frozen}
    POST /api/nexus/lookup            {domain, retry, session?}  -> in the background, searches Nexus for name-only
                                      mods, then (with NEXUS_API_KEY) fetches missing Nexus details for the session's lists
    GET  /api/nexus/progress          the background search's progress
    GET  /api/nexus/details?session=<s>  how many mods in the session's snapshots have no Nexus details cached
    POST /api/nexus/stop              stops it after the current batch (results so far are kept)
    POST /api/nexus/match             {domain, key, action: accept|reject|reset, id} -> data/nexus_match.json
"""

import argparse
import base64
import binascii
import json
import os
import shutil
import subprocess
import sys
import threading
import webbrowser
import zipfile
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import modlist_lib as lib  # noqa: E402
import import_files  # noqa: E402
import nexus_match  # noqa: E402

MAX_BODY = 60_000_000  # uploads arrive base64-encoded
VALID_DECISIONS = {"keep", "drop", "maybe", ""}
# One writer at a time per kind of data. Snapshots/imports/freeze change lists/; sessions and their
# decisions are small and frequent, so they get their own lock and never wait on a snapshot.
lists_lock = threading.Lock()
plan_lock = threading.Lock()
MAX_SETUP = 50_000  # characters of the app's saved lists and filters
# the Nexus name search and details fetch run in a background thread; the app polls its progress.
# phase: "names" (the name search) or "details" (summaries, pictures, authors from the Nexus API)
nexus_job = {"running": False, "stop": False, "domain": "", "phase": "names", "done": 0, "total": 0, "counts": {},
             "error": "", "finished": ""}
nexus_job_lock = threading.Lock()


def static_routes():
    """URL prefix -> base folder; any file under the folder may be served."""
    return [
        ("/web/", lib.REPO / "web"),
        ("/lists/", lib.LISTS),
        ("/plan/sessions/", lib.SESSIONS),
    ]


STATIC_FILES = {
    "/": lambda: lib.REPO / "index.html",
    "/index.html": lambda: lib.REPO / "index.html",
    "/data/descriptions.json": lambda: lib.DESCRIPTIONS,
    "/data/nexus_match.json": lambda: nexus_match.MATCHES,
}


def resolve_static(url_path: str):
    """Map a request path to a file on disk, or None. Only allowlisted locations are served,
    never dotfiles, never directories, and nothing that escapes its base folder."""
    path = unquote(url_path)
    if "\\" in path or "\x00" in path:
        return None
    if path in STATIC_FILES:
        f = STATIC_FILES[path]()
        return f if f.is_file() else None
    parts = PurePosixPath(path).parts[1:]
    if any(p.startswith(".") or "~" in p for p in parts):
        return None  # dotfiles, '..', and Windows 8.3 short names like ENV~1
    for prefix, base in static_routes():
        if path.startswith(prefix):
            target = (base / Path(*PurePosixPath(path[len(prefix):]).parts)).resolve()
            base = base.resolve()
            if target != base and base in target.parents and target.is_file():
                return target
            return None
    return None


def mo2_profiles(mo2: Path):
    prof = mo2 / "profiles"
    if not prof.is_dir():
        return None
    return sorted(p.name for p in prof.iterdir() if (p / "modlist.txt").exists())


def list_status():
    """Per list: where it comes from on this machine and whether MO2 changed since.
    A bad entry is reported, not fatal, so one broken file can't disable the app."""
    out, problems = {}, []
    try:
        sources = lib.read_json(lib.LOCAL_SOURCES, {}, strict=True)
    except lib.CorruptFile as e:
        return {}, [str(e)]
    for name, src in sources.items():
        try:
            info = lib.read_json(lib.LISTS / name / "info.json", None)
            if not info:
                continue
            modlist = Path(src["mo2"]) / "profiles" / src["profile"] / "modlist.txt"
            changed = None
            if modlist.exists():
                mtime = datetime.fromtimestamp(modlist.stat().st_mtime).astimezone()
                changed = mtime > datetime.fromisoformat(info["generated"])
            out[name] = {"mo2": src["mo2"], "profile": src["profile"], "changed": changed,
                         "available": modlist.exists()}
        except (KeyError, TypeError, ValueError, OSError) as e:
            problems.append(f"{name}: {e}")
    return out, problems


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(lib.REPO), **kw)

    def log_message(self, fmt, *args):
        # only log API calls and errors, not every static file
        if "/api/" in str(args[0] if args else "") or fmt.startswith("code"):
            super().log_message(fmt, *args)

    # -- guards and helpers
    def host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("localhost", "127.0.0.1")  # blocks DNS rebinding

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def translate_path(self, path):
        # SimpleHTTPRequestHandler serves whatever this returns; non-allowlisted -> a path that
        # doesn't exist, so the base class answers 404 (and never lists a directory).
        target = resolve_static(urlparse(path).path)
        return str(target) if target else str(lib.REPO / "__not_found__")

    # -- GET
    def do_GET(self):
        if not self.host_ok():
            return self.send_error(403)
        url = urlparse(self.path)
        if url.path == "/api/status":
            lists, problems = list_status()
            return self.send_json(200, {
                "local": True,
                "mo2": os.environ.get("MO2_PATH", ""),
                "profile": os.environ.get("MO2_PROFILE", "Default"),
                "list_name": os.environ.get("MO2_LIST_NAME", ""),
                "nexus_key": bool(os.environ.get("NEXUS_API_KEY")),
                "mo2_game": lib.nexus_domain(lib.instance_game(Path(os.environ["MO2_PATH"]))) if os.environ.get("MO2_PATH") else "",
                "games": lib.game_names(),
                "lists": lists,
                "problems": problems,
                "profile_files": lib.PROFILE_FILES,
                "profile_ini_pattern": lib.PROFILE_INI_RE.pattern,
                "name_pattern": lib.NAME_PATTERN,
            })
        if url.path == "/api/profiles":
            mo2 = Path((parse_qs(url.query).get("mo2") or [""])[0])
            profiles = mo2_profiles(mo2) if str(mo2) not in ("", ".") else None
            if profiles is None:
                return self.send_json(404, {"error": "No MO2 'profiles' folder found there."})
            return self.send_json(200, {"profiles": profiles})
        if url.path == "/api/nexus/progress":
            with nexus_job_lock:
                return self.send_json(200, {k: v for k, v in nexus_job.items() if k != "stop"})
        if url.path == "/api/nexus/details":
            session = lib.read_session((parse_qs(url.query).get("session") or [""])[0])
            if not session:
                return self.send_json(404, {"error": "Unknown session; reload the page."})
            mods = [m for n in session_snapshots(session) for m in lib.read_json(lib.LISTS / n / "mods.json", [])]
            return self.send_json(200, {"todo": len(lib.nexus_todo(mods, lib.read_json(lib.NEXUS_CACHE, {})))})
        if url.path.startswith("/api/"):
            return self.send_error(404)
        if resolve_static(url.path) is None:
            return self.send_error(404)
        # Last-Modified has 1-second resolution: a file rewritten within the same second (sessions
        # index after a rename + delete) would be answered "304 not modified" with the old content
        del self.headers["If-Modified-Since"]
        return super().do_GET()

    def do_HEAD(self):
        if not self.host_ok() or resolve_static(urlparse(self.path).path) is None:
            return self.send_error(404)
        return super().do_HEAD()

    # -- POST
    def read_body(self):
        # A custom header + JSON content type forces a CORS preflight, which we never
        # answer, so other websites can't drive these endpoints from your browser.
        if self.headers.get("X-Modlist-Atlas") != "1" or \
                not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return None
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length < 0 or length > MAX_BODY:
            return None
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
        return body if isinstance(body, dict) else None

    def do_POST(self):
        if not self.host_ok():
            return self.send_error(403)
        body = self.read_body()
        if body is None:
            return self.send_json(400, {"error": "Bad request."})
        routes = {
            "/api/snapshot": self.snapshot,
            "/api/import": self.import_list,
            "/api/decisions": self.save_decisions,
            "/api/freeze": self.freeze,
            "/api/session/add-list": self.add_list,
            "/api/session/remove-list": self.remove_list,
            "/api/nexus/lookup": self.nexus_lookup,
            "/api/nexus/stop": self.nexus_stop,
            "/api/nexus/match": self.nexus_set_match,
            "/api/session/create": self.create_session,
            "/api/session/rename": self.rename_session,
            "/api/session/delete": self.delete_session,
            "/api/session/setup": self.save_setup,
        }
        handler = routes.get(urlparse(self.path).path)
        if not handler:
            return self.send_error(404)
        if handler == self.save_decisions:
            return handler(body, (parse_qs(urlparse(self.path).query).get("session") or [""])[0])
        return handler(body)

    def busy(self):
        return self.send_json(409, {"error": "Another snapshot or import is running; try again when it finishes."})

    def target_session(self, body):
        """The session a new list goes into: None when none is named (older callers), False when
        the named one doesn't exist (after answering 404)."""
        if not body.get("session"):
            return None
        session = lib.read_session(str(body["session"]))
        if not session:
            self.send_json(404, {"error": "Unknown session; reload the page."})
            return False
        return session

    @staticmethod
    def shared_note(name, session):
        """Replacing a list changes it in every session that has it: say which other ones do."""
        others = [s["title"] for s in lib.sessions_using(name) if not session or s["name"] != session["name"]]
        return f" It's also in {', '.join(others)}, which will get the new version too." if others else ""

    @staticmethod
    def add_to_session(session, name):
        if session:
            with plan_lock:
                current = lib.read_session(session["name"])
                if current:
                    lib.add_session_list(current, name)

    def import_list(self, body):
        name = str(body.get("name", ""))
        if not lib.valid_name(name):
            return self.send_json(400, {"error": lib.NAME_ERROR})
        session = self.target_session(body)
        if session is False:
            return
        if not lists_lock.acquire(blocking=False):
            return self.busy()
        try:
            info = lib.read_json(lib.LISTS / name / "info.json", None)
            if info and not body.get("confirm"):
                extra = " It is frozen." if info.get("frozen") else ""
                return self.send_json(409, {"confirm": f"A list named '{name}' already exists ({info.get('mods')} mods).{extra}"
                                                       f"{self.shared_note(name, session)} Replace it?"})
            try:
                if body.get("kind") == "files":
                    named = {}
                    for f in body.get("files") or []:
                        if isinstance(f, dict):
                            named[str(f.get("name", ""))[:260]] = base64.b64decode(str(f.get("data", "")))
                    # a list uploaded into a session is for that session's game
                    result = import_files.import_files(named, name, str(body.get("title", ""))[:200],
                                                       game=session["game"] if session else str(body.get("game", "")))
                else:
                    return self.send_json(400, {"error": "Unknown import kind."})
            except (ValueError, zipfile.BadZipFile, binascii.Error) as e:
                return self.send_json(400, {"error": str(e)})
            # the list now comes from an import: forget any MO2 source it had (the frozen flag stays)
            sources = lib.read_json(lib.LOCAL_SOURCES, {})
            if sources.pop(name, None):
                lib.write_json(lib.LOCAL_SOURCES, sources)
            self.add_to_session(session, name)
            return self.send_json(200, {"ok": True, "output": f"Imported '{name}': {result['mods']} mods in {result['sections']} sections."})
        finally:
            lists_lock.release()

    def snapshot(self, body):
        mo2 = Path(str(body.get("mo2", "")))
        profile = str(body.get("profile", ""))
        name = str(body.get("name", ""))
        if not lib.valid_name(name):
            return self.send_json(400, {"error": lib.NAME_ERROR})
        profiles = mo2_profiles(mo2) if str(mo2) not in ("", ".") else None
        if profiles is None:
            return self.send_json(400, {"error": f"No MO2 'profiles' folder in {mo2}"})
        if profile not in profiles:
            return self.send_json(400, {"error": f"Profile '{profile}' not found in {mo2}"})
        session = self.target_session(body)
        if session is False:
            return
        info = lib.read_json(lib.LISTS / name / "info.json", {})
        shared = self.shared_note(name, session)
        if info.get("source") in ("upload", "loadorderlibrary") and not body.get("confirm"):  # incl. older imports
            return self.send_json(409, {"confirm": f"'{name}' was imported, not snapshotted.{shared} Replace it with this MO2 profile?"})
        if info.get("frozen") and not body.get("confirm"):
            return self.send_json(409, {"confirm": f"'{name}' is frozen.{shared} Overwrite it anyway?"})
        # refreshing a list from its own profile needs no question; replacing a different list does
        src = lib.read_json(lib.LOCAL_SOURCES, {}).get(name) or {}
        same_source = src.get("mo2") == str(mo2) and src.get("profile") == profile
        if info and not same_source and not body.get("confirm"):
            return self.send_json(409, {"confirm": f"A list named '{name}' already exists ({info.get('mods')} mods).{shared} Replace it with '{profile}'?"})
        if not lists_lock.acquire(blocking=False):
            return self.busy()
        try:
            # Nexus details are fetched in the background afterwards (if asked), not while the user waits
            cmd = [sys.executable, str(lib.REPO / "tools" / "export_modlist.py"),
                   "--mo2", str(mo2), "--profile", profile, "--name", name, "--no-api"]
            proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                                  errors="replace", cwd=lib.REPO)
        finally:
            lists_lock.release()
        ok = proc.returncode == 0
        details = False
        if ok:
            self.add_to_session(session, name)
            if body.get("details") and os.environ.get("NEXUS_API_KEY"):
                details = start_nexus_job("", False, names=False, details=[name])
        return self.send_json(200 if ok else 500, {"ok": ok, "details": details, "output": (proc.stdout + proc.stderr)[-6000:]})

    def save_decisions(self, body, session):
        """Merge only the fields sent, so a comment save can't undo a decision (or vice versa)."""
        with plan_lock:
            if not lib.read_session(session):
                return self.send_json(404, {"error": "Unknown session; reload the page."})
            path = lib.session_decisions(session)
            try:
                store = lib.read_json(path, {}, strict=True)
            except lib.CorruptFile as e:
                return self.send_json(500, {"error": f"Not saved: {e}"})
            for key, val in body.items():
                if not isinstance(key, str) or not isinstance(val, dict) or not key or len(key) > 200:
                    continue
                cur = dict(store.get(key) or {})
                if "decision" in val:
                    decision = str(val["decision"])
                    if decision not in VALID_DECISIONS:
                        continue
                    cur["decision"] = decision
                if "note" in val:
                    cur["note"] = str(val["note"])[:2000]
                for f, limit in (("name", 300), ("name_key", 200)):
                    if val.get(f):
                        cur[f] = str(val[f])[:limit]
                if not cur.get("decision") and not cur.get("note"):
                    store.pop(key, None)
                else:
                    cur["updated"] = lib.now_iso()
                    store[key] = cur
            lib.write_json(path, store)
            return self.send_json(200, {"ok": True, "count": len(store), "saved": {k: store.get(k) for k in body}})

    def create_session(self, body):
        title = str(body.get("title", "")).strip()[:80]
        game = str(body.get("game", ""))
        if not title:
            return self.send_json(400, {"error": "Give the session a name."})
        with plan_lock:
            setup, decisions, lists = {}, {}, []
            if body.get("from"):
                src = lib.read_session(str(body["from"]))
                if not src:
                    return self.send_json(404, {"error": "The session to copy no longer exists."})
                try:
                    decisions = lib.read_json(lib.session_decisions(src["name"]), {}, strict=True)
                except lib.CorruptFile as e:
                    return self.send_json(500, {"error": f"Not copied: {e}"})
                game, setup, lists = src["game"], src.get("setup") or {}, src.get("lists", [])
            if not lib.GAME_RE.match(game):
                return self.send_json(400, {"error": "Game: the Nexus game name from its URL, e.g. skyrimspecialedition."})
            session = lib.create_session(title, game, setup, decisions, lists)
        return self.send_json(200, {"ok": True, "session": session})

    def rename_session(self, body):
        title = str(body.get("title", "")).strip()[:80]
        if not title:
            return self.send_json(400, {"error": "Give the session a name."})
        with plan_lock:
            session = lib.read_session(str(body.get("name", "")))
            if not session:
                return self.send_json(404, {"error": "Unknown session."})
            session["title"] = title
            lib.write_json(lib.SESSIONS / session["name"] / "session.json", session)
            lib.rebuild_sessions_index()
        return self.send_json(200, {"ok": True})

    def delete_session(self, body):
        """Always asks first (409 + confirm). Only the session goes: its lists stay, to add to other sessions."""
        with plan_lock:
            session = lib.read_session(str(body.get("name", "")))
            if not session:
                return self.send_json(404, {"error": "Unknown session."})
            if len(list(lib.SESSIONS.glob("*/session.json"))) < 2:
                return self.send_json(400, {"error": "This is your only session. Create another one before deleting it."})
            if not body.get("confirm"):
                n = len(lib.read_json(lib.session_decisions(session["name"]), {}))
                return self.send_json(409, {"confirm": f"Delete the session '{session['title']}' and its {n} decision{'' if n == 1 else 's'}? "
                                                       "Its lists stay available to add to other sessions. This can't be undone."})
            try:
                shutil.rmtree(lib.SESSIONS / session["name"])
            except OSError as e:
                return self.send_json(500, {"error": f"Could not delete '{session['title']}': {e}"})
            finally:
                lib.rebuild_sessions_index()
        return self.send_json(200, {"ok": True})

    def save_setup(self, body):
        setup = body.get("setup")
        if not isinstance(setup, dict) or len(json.dumps(setup)) > MAX_SETUP:
            return self.send_json(400, {"error": "Bad request."})
        with plan_lock:
            session = lib.read_session(str(body.get("name", "")))
            if not session:
                return self.send_json(404, {"error": "Unknown session."})
            session["setup"] = setup
            lib.write_json(lib.SESSIONS / session["name"] / "session.json", session)
        return self.send_json(200, {"ok": True})

    def freeze(self, body):
        name = str(body.get("name", ""))
        path = lib.LISTS / name / "info.json"
        if not lib.valid_name(name) or not path.exists():
            return self.send_json(404, {"error": "Unknown list."})
        if not lists_lock.acquire(blocking=False):
            return self.busy()
        try:
            info = lib.read_json(path, {})
            info["frozen"] = bool(body.get("frozen"))
            lib.write_json(path, info)
            lib.rebuild_index()
        finally:
            lists_lock.release()
        return self.send_json(200, {"ok": True})

    def add_list(self, body):
        name = str(body.get("name", ""))
        if not lib.valid_name(name) or not (lib.LISTS / name / "info.json").is_file():
            return self.send_json(404, {"error": "Unknown list."})
        with plan_lock:
            session = lib.read_session(str(body.get("session", "")))
            if not session:
                return self.send_json(404, {"error": "Unknown session; reload the page."})
            lib.add_session_list(session, name)
        return self.send_json(200, {"ok": True})

    def remove_list(self, body):
        """Takes a list out of one session. When no other session has it, its files are deleted too,
        so that asks first (409 + confirm). Decisions are keyed by mod, not list, so they stay."""
        name = str(body.get("name", ""))
        folder = lib.LISTS / name
        if not lib.valid_name(name) or not (folder / "info.json").is_file():
            return self.send_json(404, {"error": "Unknown list."})
        if not lists_lock.acquire(blocking=False):
            return self.busy()
        try:
            with plan_lock:
                session = lib.read_session(str(body.get("session", "")))
                if not session or name not in session.get("lists", []):
                    return self.send_json(404, {"error": "That list isn't in this session; reload the page."})
                others = [s["title"] for s in lib.sessions_using(name) if s["name"] != session["name"]]
                if not others and not body.get("confirm"):
                    info = lib.read_json(folder / "info.json", {})
                    extra = " It is frozen." if info.get("frozen") else ""
                    return self.send_json(409, {"confirm": f"Remove the list '{name}' ({info.get('mods')} mods)?{extra} No other session "
                                                           "has it, so its files are deleted. Your decisions are kept. This can't be undone."})
                session["lists"].remove(name)
                lib.write_session(session)
                lib.rebuild_sessions_index()
            if others:
                return self.send_json(200, {"ok": True, "kept_in": others})
            try:
                shutil.rmtree(folder)
            except OSError as e:
                return self.send_json(500, {"error": f"Could not delete '{name}': {e}"})
            finally:
                lib.rebuild_index()
            sources = lib.read_json(lib.LOCAL_SOURCES, {})
            if sources.pop(name, None):
                lib.write_json(lib.LOCAL_SOURCES, sources)
        finally:
            lists_lock.release()
        return self.send_json(200, {"ok": True, "kept_in": []})

    def nexus_lookup(self, body):
        domain = str(body.get("domain", ""))
        if not nexus_match.DOMAIN_RE.match(domain):
            return self.send_json(400, {"error": "Game: the Nexus game name from its URL, e.g. skyrimspecialedition."})
        session = self.target_session(body)
        if session is False:
            return
        # details come from the Nexus API, so only with a key; only snapshots have the Nexus IDs to look up
        details = session_snapshots(session) if session and os.environ.get("NEXUS_API_KEY") else []
        if not start_nexus_job(domain, bool(body.get("retry")), details=details):
            return self.send_json(409, {"error": "A Nexus search is already running."})
        return self.send_json(200, {"ok": True})

    def nexus_stop(self, body):
        with nexus_job_lock:
            nexus_job["stop"] = True
        return self.send_json(200, {"ok": True})

    def nexus_set_match(self, body):
        domain, key, action = str(body.get("domain", "")), str(body.get("key", "")), str(body.get("action", ""))
        if not nexus_match.DOMAIN_RE.match(domain) or not key.startswith("name:") or len(key) > 300:
            return self.send_json(400, {"error": "Bad request."})
        mod_id = body.get("id")
        if action == "accept" and (not isinstance(mod_id, int) or isinstance(mod_id, bool)):
            return self.send_json(400, {"error": "Bad mod id."})
        try:
            entry = nexus_match.set_status(domain, key, action, mod_id)
        except KeyError:
            return self.send_json(404, {"error": "No Nexus search result for that mod."})
        except ValueError as e:
            return self.send_json(400, {"error": str(e)})
        return self.send_json(200, {"ok": True, "entry": entry})


def snapshots(names=None) -> list:
    """MO2 snapshots (only they have Nexus IDs to fetch details for), all or those in names."""
    return [i["name"] for i in lib.read_json(lib.LISTS / "index.json", [])
            if i.get("source") == "mo2" and (names is None or i["name"] in names)]


def session_snapshots(session) -> list:
    return snapshots(session.get("lists", []))


def start_nexus_job(domain: str, retry: bool, names: bool = True, details=()) -> bool:
    """False when a job is already running."""
    with nexus_job_lock:
        if nexus_job["running"]:
            return False
        nexus_job.update(running=True, stop=False, domain=domain, phase="names" if names else "details",
                         done=0, total=0, counts={}, error="", finished="")
    threading.Thread(target=run_nexus_job, args=(domain, retry, names, list(details)), daemon=True).start()
    return True


def run_nexus_job(domain: str, retry: bool, names: bool = True, details=()):
    def progress(done, total, counts):
        with nexus_job_lock:
            nexus_job.update(done=done, total=total, counts=dict(counts))

    def details_progress(done, total):
        with nexus_job_lock:
            nexus_job.update(done=done, total=total)

    def should_stop():
        with nexus_job_lock:
            return nexus_job["stop"]

    error = ""
    try:
        if names:
            with nexus_job_lock:
                nexus_job["total"] = len(nexus_match.pending(domain, retry))
            nexus_match.run(domain, retry, progress=progress, should_stop=should_stop)
        if details and not should_stop():
            with nexus_job_lock:
                nexus_job.update(phase="details", done=0, total=0)
            mods = [m for n in details for m in lib.read_json(lib.LISTS / n / "mods.json", [])]
            lib.fetch_nexus(mods, os.environ.get("NEXUS_API_KEY", ""), progress=details_progress, should_stop=should_stop)
    except nexus_match.RateLimited:
        error = "Nexus is limiting requests. Results so far are saved; run it again later to continue."
    except Exception as e:  # network trouble etc.: report it, keep what was saved
        error = f"Search stopped: {e}. Results so far are saved; run it again to continue."
    if details:
        # every snapshot, not only the ones fetched for: an older one may miss mods the cache has now
        with lists_lock:  # waits for a running snapshot or import
            for n in snapshots():
                try:
                    lib.reapply_nexus_cache(n)
                except (OSError, ValueError) as e:
                    error = error or f"Could not update '{n}' with the Nexus details: {e}"
    with nexus_job_lock:
        nexus_job.update(running=False, error=error, finished=lib.now_iso())


class Server(ThreadingHTTPServer):
    # the default backlog of 5 makes Windows drop connections when the app fires several saves at once
    request_queue_size = 64
    daemon_threads = True


def make_server(port: int) -> ThreadingHTTPServer:
    lib.rebuild_index()
    lib.migrate_to_sessions()
    lib.migrate_session_lists()
    return Server(("127.0.0.1", port), Handler)


def main():
    lib.load_dotenv()
    ap = argparse.ArgumentParser(description="Serve Modlist Atlas locally.")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    server = make_server(args.port)
    url = f"http://localhost:{args.port}/"
    print(f"Modlist Atlas running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
