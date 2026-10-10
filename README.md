# Modlist Atlas

**Compare · browse · plan Mod Organizer 2 modlists.**

A small local web app and toolkit for Mod Organizer 2 users. Take snapshots of your MO2 profiles,
import other people's lists, see every mod side by side across lists, and record keep / drop / maybe
decisions with comments while you build a new setup (for example, moving to a Wabbajack list).

Works with the games Mod Organizer 2 manages (Skyrim, Fallout, Oblivion, Morrowind, Starfield and
others). Nexus links are mapped for the common ones; for less common games the link uses a best guess
at the game's Nexus section.

## Features

- **Compare** any number of lists: one row per mod, one column per list, with filters such as
  *in list A but not in list B* and a clickable overlap bar.
- **Browse** a list as cards or a table, grouped by MO2 separator or Nexus category, with search,
  filters, Nexus links, descriptions and thumbnails (with a Nexus API key).
- **Plan**: Keep / Drop / Maybe per mod with comments, and a progress view.
- **Add lists** from an MO2 profile on this PC, or upload profile files (a folder, a `.zip` or a
  `modlist.txt`), e.g. someone else's profile or a list shared on a site like Load Order Library.
- Read-only towards MO2: it never changes your MO2 install.

## Requirements

- Windows with Python 3.10+ (standard library only, nothing to install)
- Mod Organizer 2 for snapshots of your own profiles (any game it supports; Vortex lists aren't supported)

## Setup

```powershell
git clone https://github.com/vivekmtk/modlist-atlas.git
cd modlist-atlas
Copy-Item .env.example .env
notepad .env        # MO2_PATH, MO2_PROFILE, MO2_LIST_NAME, optional NEXUS_API_KEY
```

The Nexus API key (nexusmods.com → Site preferences → API Keys) is optional. It adds the official
one-line summaries and thumbnails; results are cached locally so only new mods are looked up.

## Usage

Double-click **`Modlist Atlas.bat`** (or run `python tools/serve.py`). It opens `http://localhost:8000`
and only listens on your own PC.

- **Add list** → *MO2 profile* or *Upload files*. **Delete** on a list's Overview card removes it;
  your decisions are kept.
- **Compare** → click list chips to cycle *any → in → not in*, or click an overlap segment.
- **Browse** → click a mod for its description, which lists contain it, and decisions.
- Shortcuts: `/` search · in a mod: `K` / `D` / `M` keep / drop / maybe, `C` comment, `←` / `→`
  previous / next, `Esc` leaves the comment box, then closes. Table rows open with `Enter`.

Command line equivalents:

```powershell
python tools/export_modlist.py                                   # snapshot using .env
python tools/export_modlist.py --mo2 "<MO2 folder>" --profile "<profile>" --name <list>
python tools/export_modlist.py --name <list> --freeze            # ask before overwriting
python tools/import_files.py "<profile folder | .zip | files>" --name <list>
```

Without a Nexus API key the tool makes no network requests: it only reads your MO2 folder and the
files you upload. The key is optional, entered by you, and used only for your own lists (personal
use, as Nexus's API policy allows).

## Where your data lives

| Folder | Contents |
|---|---|
| `lists/<name>/` | Snapshots: `MODLIST.md`, `MODLIST_BY_CATEGORY.md`, `LOADORDER.md`, `mods.csv`/`json`, MO2 profile files |
| `plan/` | `decisions.json`: your keep / drop / maybe decisions and comments |
| `data/` | Nexus descriptions read from MO2 and Nexus API results |
| `.env`, `.lists.local.json` | Your settings and which MO2 folder each list came from |

Absolute paths and the graphics adapter name are blanked when INIs are copied. To keep a history of
your own lists, back up these folders or make `lists/` and `plan/` a separate private repository.
Set `ATLAS_HOME` to keep this data in another folder instead of the repo folder.

## Tests

```powershell
python -m unittest discover tests
```

The tests use a temporary `ATLAS_HOME` and a fake MO2 install; they never touch your real data or the
network.

## Rebuilding a setup from a snapshot

1. Install MO2 and the game, and create a profile.
2. Copy `lists/<name>/profile/*` into `Mod Organizer 2/profiles/<profile>/` and re-set any blanked INI
   values (such as the screenshot folder).
3. Install each mod from the links in `MODLIST.md`, keeping the **same mod names** (MO2 matches
   `modlist.txt` entries by folder name).
4. Regenerate generated outputs that aren't on Nexus (for Skyrim, e.g. DynDOLOD, xLODGen, TexGen,
   Grass Cache, PGPatcher).

## Credits and notes

- Built with AI assistance ([Claude Code](https://claude.com/claude-code)); reviewed and directed by
  the author.
- Mod names, summaries, descriptions and images belong to their respective authors on
  [Nexus Mods](https://www.nexusmods.com). This project only links to them and caches them locally.
- Not affiliated with any game publisher, Nexus Mods, Mod Organizer 2, Wabbajack or Load Order Library.

## License

[MIT](LICENSE) © 2026 Vivek Muralidharan
