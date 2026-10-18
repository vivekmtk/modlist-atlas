# Design

## What it does

Snapshots Mod Organizer 2 modlists for any MO2-managed game (MO2 profiles and uploaded profile
files) and provides a local web app, Modlist Atlas, to compare, browse and plan them, with
keep / drop / maybe decisions while building a new setup on top of a Wabbajack list.

## Components

```
MO2 instance (read-only) ────► tools/export_modlist.py ─┐
Profile files / folder / zip ► tools/import_files.py ───┤  (shared code: tools/modlist_lib.py)
Nexus API (optional key) / Nexus search (on request) ───┤
                                                         ▼
       lists/<name>/{mods.json, mods.csv, MODLIST*.md, LOADORDER.md, info.json, profile/, notes/}
       lists/index.json             data/descriptions.json, data/nexus_cache.json, data/nexus_match.json
       plan/sessions/index.json     plan/sessions/<session>/{session.json, decisions.json}
                                                         │
index.html + web/app.{js,css}  ◄── fetch ────────────────┘
        ▲            │ POST snapshot / import / decisions / sessions / freeze
        └── tools/serve.py (127.0.0.1 only) ──► plan/sessions/, runs export_modlist.py
```

- **export_modlist.py** reads `modlist.txt`, `plugins.txt` and each mod's `meta.ini` (Nexus ID,
  version, category, cached description, notes) and copies the profile files (INI paths and the
  graphics adapter name blanked).
- **import_files.py** takes uploaded profile files (loose, a folder, or a zip) when the MO2 install
  isn't available, e.g. a list saved from a modlist website. These only have mod names.
- **nexus_match.py** finds Nexus mods for name-only mods by title (public v2 GraphQL API, no key),
  batching 12 names per request, and caches every result and the user's choices.
- **serve.py** serves the app and a small JSON API. It runs the exporter as a subprocess with
  validated arguments (no shell), so the browser can trigger snapshots and imports.
- **web app** is static (no build step, no framework); without the server it is read-only.

## Key decisions

- **The repository holds the tool only.** Snapshots (`lists/`), decisions (`plan/`) and caches
  (`data/`) are personal or third-party data and are git-ignored, as are `.env` and
  `.lists.local.json`. Nothing about a user's setup or another author's list is ever committed.
- **Never write to MO2.** Snapshots copy files out; nothing goes back.
- **No third-party APIs except Nexus, and only when asked.** Lists from websites are added by
  uploading their `modlist.txt`, so the tool doesn't depend on any site's unpublished API. Nexus is
  contacted only when the user asks: **Find on Nexus**, **Fetch Nexus details** on a new snapshot,
  or a command-line export with an API key. Mod pictures are stored as Nexus URLs, not downloaded,
  so the browser loads them from Nexus while the user views lists that have Nexus details;
  otherwise the tool makes no network requests at all.
- **Snapshots never wait for Nexus.** The app's snapshots run the exporter with `--no-api`, so a
  list is saved in seconds. Nexus details (summaries, pictures, authors) are fetched in the same
  background job as the name search, either for the new list (the snapshot's checkbox) or for the
  session's MO2 snapshots (**Find on Nexus**, after the name search). When it finishes, every MO2
  snapshot the cache has something new for is rewritten from the cache and its own copy of
  `modlist.txt` (not only the ones fetched for, so an older snapshot never stays behind the cache),
  without reading MO2 again, so a changed MO2 profile is never snapshotted behind the user's back.
  The dialog's count comes from the server, which knows the cache, so cached mods aren't counted.
- **Name search: automatic only when unambiguous.** A name-only mod is linked automatically only
  when exactly one Nexus mod in that game has that exact title. Similar titles (all words present),
  and searches on a trimmed name (`X - BSA Version` → `X`), are only suggestions for the user to
  accept or reject, because a trimmed name often points at the main mod instead of its patch.
  Results are keyed by game and normalized name, so a name is searched once across all lists;
  accepted / rejected choices are never overwritten by later searches. The app applies matches
  when building its catalog, so a matched mod merges with the same Nexus mod from MO2 lists.
- **Game-neutral.** Each mod's Nexus game comes from its own `meta.ini` (`gameName`), falling
  back to the instance's game in `ModOrganizer.ini`; known MO2 short names map to Nexus domains
  (`FalloutNV` → `newvegas`) and unknown ones fall back to the lowercase name. Any `.ini` in the
  profile folder is kept (the game's and MO2's), so no game's file names are hard-coded.
- **One folder per list, plus shared caches.** Each snapshot is self-contained and readable as
  Markdown. Descriptions (~3.5 MB) and Nexus API results are shared across lists in `data/` so
  they are stored once and fetched once.
- **Mod identity = Nexus key** (`skyrimspecialedition/<id>`), falling back to a normalized name
  (`name:<letters+digits>`). The web app resolves name-only mods (uploaded lists) to
  a Nexus key when any other list has a mod with the same normalized name, and borrows its link,
  category and description. "Any other list" includes the game's MO2 snapshots outside the session:
  the app loads them for reference only (never shown as lists), so a mod's Nexus ID and details,
  which belong to the mod and not to a list, reach every session without extra Nexus requests. The
  name search skips the same names, since it already checks every list on disk. Several MO2 mods can share one Nexus key (main file + optional files);
  they're shown as one record with "+N files" in Compare.
- **Sessions separate plans, including their lists.** A session is a name, a game, its lists
  (`session.json: lists`), the app's setup (filters, view) and its own decisions, in
  `plan/sessions/<name>/`. A snapshot or upload made in the app goes into the open session (an
  upload takes the session's game); a list can be added to other sessions. Lists are still stored
  once in `lists/`, so adding one to another session copies nothing and a re-snapshot updates it
  in every session that has it; the server says which other sessions a replace affects. Removing a
  list takes it out of one session; its files go only when no session has it, after asking.
  Deleting a session keeps its lists, and lists made on the command line start in no session;
  both can be added from the app. Sessions saved before lists belonged to sessions get, on start,
  the lists they showed then: every list for their game and lists with no game. The session's game
  also scopes Find on Nexus, so one game's name matches never apply to another's lists. The folder name is derived
  from the title, so users only ever see titles. Duplicate copies lists, decisions and setup; deleting
  keeps at least one session. Which session is open is remembered per browser; the setup is saved
  on disk with the session.
- **Upgrading moves, never drops, decisions.** On start, if no session exists but lists or the old
  `plan/decisions.json` do, every list gets its game (the most common one among its mods; uploads,
  which have none, get the most common game across lists) and the decisions move into a *Default*
  session for that game. The old file is renamed to `decisions.before-sessions.json` only after the
  session is written, so a crash mid-way repeats the upgrade. A fresh install gets no session; the
  app asks for a name and game first.
- **Decisions are keyed by mod identity** (`plan/sessions/<name>/decisions.json`, each with an
  optional comment), so they survive re-exports and apply across every list containing the mod. Each also stores the
  mod's normalized name, so it still matches if the mod's key changes (e.g. the list that supplied
  the Nexus ID is deleted).
- **Decisions are never lost to concurrency or crashes.** The server merges only the fields a request
  sends (a comment save can't undo a decision), serialises writes with a lock, writes JSON
  atomically (temp file + rename), and refuses to save over a file it can't parse.
- **Data location is configurable.** `ATLAS_HOME` points `lists/`, `plan/`, `data/` and
  `.lists.local.json` at another folder; the tests use it to run against a temporary home.
- **One writer at a time for lists.** Snapshots, imports and freeze share a lock and answer "busy"
  rather than interleaving writes; decisions have their own lock so they never wait on a snapshot.
- **No machine-specific values in code.** Paths come from `.env` or flags; the decisions panel
  defaults to the first frozen list rather than a hard-coded name.
- **Frozen lists** (`info.json: frozen`) are protected: the app asks before overwriting them.
- **No "304 Not Modified".** Last-Modified has one-second resolution, so a file rewritten twice in
  a second (the sessions index after rename then delete) would be served stale; the server ignores
  `If-Modified-Since` and always sends the file.
- **Local server hardening:** binds to 127.0.0.1; rejects non-localhost `Host` headers (DNS
  rebinding); serves an allowlist only (the app, `lists/`, descriptions, decisions), never dotfiles,
  `..`, Windows 8.3 short names or directories; POSTs need a custom header plus JSON content type,
  which forces a CORS preflight that is never granted, so other websites can't drive the API.
- **Untrusted list data is inert in the browser.** Everything is HTML-escaped, only `http(s)` URLs
  become links or images, and a Content-Security-Policy forbids inline and third-party scripts.
  CSV exports prefix formula-like cells so spreadsheets don't execute them.
- **Shared rules have one source.** The server sends the allowed profile files and the list-name
  rule to the app via `/api/status`.
- **Tables scroll with the page**, their header row sticking under the app header, and columns wrap
  to fit the window. Only a table still too wide (narrow window, many lists) gets its own frame
  that scrolls both ways, with a frozen Mod column and the horizontal scrollbar kept on screen.
- **One theme, one scale.** The app has its own Nordic look. Every radius, font size, control height and fixed colour comes from the
  tokens at the top of `app.css`; selected states are gold, Nexus-related things are frost blue,
  filters are pills and actions are rounded rectangles.
- **Re-rendering keeps context.** The app re-renders from state on every change, but restores the
  sidebar's scroll and open state and the focused element, and returns focus to what opened the
  drawer, so mouse, keyboard and phone use don't lose their place.

## Limitations

- Uploaded lists have no Nexus IDs or versions. Name search finds most mods, but renamed folders
  and tool outputs need confirming by hand or aren't found; versions stay unknown until the list
  is installed and snapshotted from MO2.
- Mods without a Nexus ID (tool outputs, manual installs) have no link or category.
- Summaries without a Nexus API key are derived from the cached description and can be poor.
- Compare colours repeat after 8 lists (each list keeps its colour in this browser).
- `web/app.js` is a single file; split it into ES modules if it keeps growing.
- Rebuilding a setup still means downloading each mod manually.
