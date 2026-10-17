# Kerf Sabre (BISAK Kerf) — root rules

Source of truth: `docs/BRIEF.md`. Read it before non-trivial work. Internal school use only.

## Components
- **BISAK Kerf Editor** (`editor/`): TypeScript PWA. Design mode (pupils) and Station mode (laser PCs).
- **BISAK Kerf Server** (`server/`): Python. DXF clean-up, G-code, presets, queue, log collection.
- **BISAK Kerf Cutter** (`cutter/`): Python station agent. GRBL serial, camera, logs. Outbound connection only. This is the **Creality Falcon Cutter** (the Admin site and the API kind `creality-falcon` use that name). The GCC Mercury III (station 5) is not GRBL and will be a separate Cutter.
- `shared/`: versioned JSON schemas and API contract. `spike/`: throwaway connectivity spike. `fixtures/dxf/`: real Onshape DXFs.

## Running it
`python3 start.py` (Windows `start.bat`, Mac/Linux `./start.sh`) starts the Server, Editor and a laser connector on one PC on non-clashing ports (`--dev` adds Vite live reload, `--lan` shares on the network). The connector is the pretend Cutter until the real one exists.

## Rules
- Units are millimetres (float) everywhere. Bed space is Y-up, origin = machine origin from the machine profile.
- G-code is absolute: start with `G21` and `G90`. **Never use `G92`.**
- Machine facts (bed size, origin, `$30`, air assist) come from machine profiles, never hard-coded.
- Layer types: Score and Cut (no engraving), plus **Ignore** (dark grey): drawn and saved with the file but never cut, scored, exported to DXF/SVG, sized, fit-checked or put in G-code (`gcode.cuttable` on the server).
- Logs carry pupil IDs, never names. No camera frames in logs. Exception decided by the school (shared 0.2.22): a DINO display *name* (never an email) is stored in `people` and shown to staff of the same school only; it is never logged, never shown to other pupils, and deleted when the pupil is removed.
- Each session edits only its own folder. `shared/` changes need a version bump and a `shared/CHANGELOG.md` entry; only one feature at a time may change `shared/`.
- Production Cutter work is gated on spike results from all four station PCs. Editor and Server work is not.
- Station PCs: no installers, no Claude Code. Deploy as portable folders (embeddable Python + bundled deps + `.bat`). Everything must be debuggable from logs.

## Git workflow
- **Always commit to `main` and push `main`** (owner's standing instruction). No feature branches and no pull requests unless explicitly asked. Commit small; pull/rebase before pushing; run the component tests first.

## Tests
- Python: `pytest` from the component folder (`spike/`, `shared/`, later `server/`, `cutter/`).
- Editor: set when the editor is scaffolded.
