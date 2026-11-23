# Kerf Sabre (Kerf) — root rules

Source of truth: `docs/BRIEF.md`. Read it before non-trivial work.

## Ownership
Kerf Sabre is owned by **mr-salih.org** (Leroy Salih's own work and intellectual property, built on his own time with his own Claude subscription, not as part of any job). It may become a product (a free Editor, paid Server features). The product, its code, names and branding carry no school's name: say "Kerf" (Kerf Editor, Kerf Server, Kerf Cutter), use neutral examples (e.g. `westfield-high`), and treat any school's names, lasers and settings as that customer's configuration, never as part of the product.
Product decisions (`docs/PRODUCT.md`): **hosted only** (one multi-school Kerf Server run by mr-salih.org, no self-hosted edition), **one subscription per school**, and the **design Editor is free and open source under AGPL-3.0** (`editor/LICENSE`, `editor/LICENSING.md`); **Kerf Server and Kerf Cutter are proprietary** (`server/LICENSE`, `cutter/LICENSE`), as are the Admin site and Station mode screens that still live in `editor/` until the split. **One code base:** BISAK is one customer school on the same hosted Kerf, never a fork or a special build; anything only BISAK uses today (DINO sign-in, its lasers and materials) must be a per-school setting any school could use. Schools sign themselves up: a teacher registers the school and becomes its admin, then adds teachers and pupils. Do not add code to the Editor that ties it to one school or makes it need a server for design work, and check a new Editor dependency's licence first (image tracing uses GPL-2.0 potrace, which limits the Editor's licence).

## Components
- **Kerf Editor** (`editor/`): TypeScript PWA. Design mode (pupils) and Station mode (laser PCs).
- **Kerf Server** (`server/`): Python. DXF clean-up, G-code, presets, queue, log collection.
- **Kerf Cutter** (`cutter/`): Python station agent. GRBL serial, camera, logs. Outbound connection only. This is the **Creality Falcon Cutter** (the Admin site and the API kind `creality-falcon` use that name). The GCC Mercury III (station 5) is not GRBL and will be a separate Cutter.
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
