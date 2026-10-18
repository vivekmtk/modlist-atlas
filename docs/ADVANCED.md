# Modlist Atlas: advanced use

Extra steps for when you need them. For everything else, see the [README](../README.md).

## Rebuilding a setup from a snapshot

1. Install MO2 and the game, and create a profile.
2. Copy `lists/<name>/profile/*` into `Mod Organizer 2/profiles/<profile>/` and re-set any blanked
   INI values (such as the screenshot folder).
3. Install each mod from the links in `MODLIST.md`, keeping the **same mod names** (MO2 matches
   `modlist.txt` entries by folder name).
4. Regenerate outputs that aren't on Nexus (for Skyrim: DynDOLOD, xLODGen, TexGen, Grass Cache,
   PGPatcher and similar).

## Command line

The same snapshots and imports are available without the web app:

```powershell
python tools/export_modlist.py                                   # snapshot using .env
python tools/export_modlist.py --mo2 "<MO2 folder>" --profile "<profile>" --name <list>
python tools/export_modlist.py --name <list> --freeze            # ask before overwriting
python tools/import_files.py "<profile folder | .zip | files>" --name <list> --game <nexus game, e.g. morrowind>
python tools/serve.py --port 8123 --no-browser                   # another port, no browser
```
