# Design

## What it does

Snapshots Mod Organizer 2 modlists for any MO2-managed game (MO2 profiles and uploaded profile
files) and provides a local web app, Modlist Atlas, to compare, browse and plan them, with
keep / drop / maybe decisions while building a new setup on top of a Wabbajack list.

## Components

```
MO2 instance (read-only) ────► tools/export_modlist.py ─┐
Profile files / folder / zip ► tools/import_files.py ───┤  (shared code: tools/modlist_lib.py)
Nexus API (optional) ───────────────────────────────────┤
                                                         ▼
       lists/<name>/{mods.json, mods.csv, MODLIST*.md, LOADORDER.md, info.json, profile/, notes/}
       lists/index.json             data/descriptions.json, data/nexus_cache.json
                                                         │
index.html + web/app.{js,css}  ◄── fetch ────────────────┘
        ▲            │ POST snapshot / import / decisions / freeze
        └── tools/serve.py (127.0.0.1 only) ──► plan/decisions.json, runs export_modlist.py
```

- **export_modlist.py** reads `modlist.txt`, `plugins.txt` and each mod's `meta.ini` (Nexus ID,
  version, category, cached description, notes) and copies the profile files (INI paths and the
  graphics adapter name blanked).
- **import_files.py** takes uploaded profile files (loose, a folder, or a zip) when the MO2 install
  isn't available, e.g. a list saved from a modlist website. These only have mod names.
- **serve.py** serves the app and a small JSON API. It runs the exporter as a subprocess with
  validated arguments (no shell), so the browser can trigger snapshots and imports.
- **web app** is static (no build step, no framework); without the server it is read-only.

## Key decisions

- **The repository holds the tool only.** Snapshots (`lists/`), decisions (`plan/`) and caches
  (`data/`) are personal or third-party data and are git-ignored, as are `.env` and
  `.lists.local.json`. Nothing about a user's setup or another author's list is ever committed.
- **Never write to MO2.** Snapshots copy files out; nothing goes back.
- **No third-party APIs except an optional Nexus key.** Lists from websites are added by uploading
  their `modlist.txt`, so the tool doesn't depend on any site's unpublished API. Without a Nexus key
  it makes no network requests at all.
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
  category and description. Several MO2 mods can share one Nexus key (main file + optional files);
  they're shown as one record with "+N files" in Compare.
- **Decisions are keyed by mod identity** (`plan/decisions.json`, each with an optional comment),
  so they survive re-exports and apply across every list containing the mod. Each also stores the
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
- **Local server hardening:** binds to 127.0.0.1; rejects non-localhost `Host` headers (DNS
  rebinding); serves an allowlist only (the app, `lists/`, descriptions, decisions), never dotfiles,
  `..`, Windows 8.3 short names or directories; POSTs need a custom header plus JSON content type,
  which forces a CORS preflight that is never granted, so other websites can't drive the API.
- **Untrusted list data is inert in the browser.** Everything is HTML-escaped, only `http(s)` URLs
  become links or images, and a Content-Security-Policy forbids inline and third-party scripts.
  CSV exports prefix formula-like cells so spreadsheets don't execute them.
- **Shared rules have one source.** The server sends the allowed profile files and the list-name
  rule to the app via `/api/status`.
- **Re-rendering keeps context.** The app re-renders from state on every change, but restores the
  sidebar's scroll and open state and the focused element, and returns focus to what opened the
  drawer, so mouse, keyboard and phone use don't lose their place.

## Limitations

- Uploaded lists have no Nexus IDs; matching by name misses renamed mods
  until the list is installed and snapshotted from MO2.
- Mods without a Nexus ID (tool outputs, manual installs) have no link or category.
- Summaries without a Nexus API key are derived from the cached description and can be poor.
- Compare colours repeat after 8 lists (each list keeps its colour in this browser).
- `web/app.js` is a single file; split it into ES modules if it keeps growing.
- Rebuilding a setup still means downloading each mod manually.
