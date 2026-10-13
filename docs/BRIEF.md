# Kerf Sabre (BISAK Kerf) — Project Brief for Claude Code

## 0. Instructions for this session

1. Read this whole brief before doing anything.
2. The project runs on **two parallel tracks** (section 13):
   - **Track A, Machine:** spike, then production Cutter. Risky, gated on hardware results.
   - **Track B, Design:** shared schemas, then Editor + Server. Independent of the lasers.
   Kerf Editor is valuable **on its own** as a free DXF editor for pupils (import, clean-up, edit, export DXF/SVG/G-code), even if direct machine control never works. Track B must not depend on Track A.
3. Enter plan mode and produce an implementation plan for the **repository scaffold**, the **spike** (Track A step 1) and the **shared schemas** (Track B step 1). Wait for approval.
4. After approval:
   - Create the repository structure (section 12), the root `CLAUDE.md` and the per-folder `CLAUDE.md` files, encoding the rules in this brief.
   - Build the spike (section 14).
   - Draft the shared schemas and API contract.
5. **Gating applies to Track A only:** do not start production Cutter work until the spike has run on all four station PCs and the results are reviewed. Editor and Server work may proceed in parallel. Anything in Editor or Server that depends on machine facts (bed size, origin, `$30`, air assist) reads from machine profiles, using placeholder profiles until spike results replace them.
6. Keep this brief in the repo as `docs/BRIEF.md`. It is the source of truth.
7. **Git workflow: solo developer, worktrees for features, no pull requests.**
   - Each feature is developed in its own git worktree on a local feature branch (e.g. `feature/dxf-cleanup`).
   - Commit in small, logical steps with clear messages.
   - When the feature is complete and its tests pass:
     1. `git pull --rebase origin main` on `main`.
     2. Rebase the feature branch onto `main`.
     3. Merge it into `main` (fast-forward preferred).
     4. Push `main` to `origin`.
     5. Remove the worktree and delete the local feature branch.
   - Never open a pull request.
   - Feature branches stay local by default. In a cloud session, unpushed work is lost if the VM is reclaimed, so for long-running features, push the feature branch to `origin` as a backup. Cloud sessions cannot delete remote branches; Leroy deletes those on GitHub.

---

## 1. Context

- **School:** BISAK (British International School, Al Khobar). Design & Technology department.
- **Hardware:**
  - 4 Creality Falcon diode laser cutters, all with built-in cameras. **Exact models TBC.**
  - 4 dedicated Windows station PCs, each connected by USB to one laser (1:1).
- **Current workflow:** pupils design in Onshape in a separate classroom, export DXF, and take files to the laser PCs.
- **Goal:** an in-house suite that replaces LightBurn for the department's workflow.
- **Not for publication.** Internal school use only.
- **Project / repository name: Kerf Sabre** (GitHub repo `kerf-sabre`). The three components keep their names: BISAK Kerf Editor, Server and Cutter.

## 2. Architecture and names

| Component | Name | Language | Runs on | Role |
|---|---|---|---|---|
| Web PWA | **BISAK Kerf Editor** | TypeScript | Served from Leroy's server; used in Chrome/Edge | **Design mode** (pupils, classroom): import DXF, assign layers, edit, submit job. **Station mode** (laser PCs): queue, camera view, frame, run/stop |
| Central service | **BISAK Kerf Server** | Python | Leroy's own server/VPS | DXF clean-up, G-code generation, material presets, job queue, relay between Editor and Cutters, log collection |
| Station agent (×4) | **BISAK Kerf Cutter** | Python | Each station PC | GRBL serial streaming, camera capture, status reporting, local + shipped logs |

**Data flow:** pupil submits from Editor → Server validates and generates G-code → job queued → at a station, Editor (station mode) selects job → Server assigns to that station's Cutter → Cutter streams to laser and reports status/camera back via Server.

**Networking:** Cutter makes an **outbound** WebSocket/HTTPS connection to Server. No inbound ports on the school network. Pupil devices never talk to hardware directly; no Web Serial.

Jobs run in the Cutter process, so closing a browser never interrupts a cut.

## 3. Hard constraints

- **Claude Code cannot be installed on the station PCs.** Everything running there must be debuggable from logs and diagnostic bundles alone. Logging is a first-class feature, not an afterthought (section 9).
- **No installers on station PCs.** Python code (spike and Cutter) is deployed as a **portable folder**: the official Windows **embeddable Python** package (python.org zip) with all dependencies bundled inside, launched by a `.bat` file. No admin rights, no registry changes; deleting the folder removes everything. A PyInstaller `.exe` is a fallback only, since `.exe` files are hard to get installed and school antivirus may flag unsigned executables.
- Application whitelisting (e.g. AppLocker) may block executables run from user folders, including `python.exe`. If so, IT must allow-list the folder.
- Cutter must be trivially replaceable: updating means replacing the folder (or the Python source within it).
- Editor targets **Chrome/Edge desktop**. Pupil devices need no installs.
- **Data protection:** logs carry pupil IDs, never names. No camera frames in logs by default. No recording by default.
- Per Leroy's standing rule: code changes are made through Claude Code only.

## 4. Machine communication — known facts

- Falcon controllers run **GRBL 1.1f**. USB enumerates as a **CH340 USB-serial** COM port (Windows needs the CH340 driver).
- Protocol: G-code streamed line by line. Use send-and-wait-for-`ok` (character-counting buffer optional later). Status via `?`. Realtime: `!` feed hold, `~` resume, `0x18` soft reset. Settings via `$$`.
- Only one program can hold the COM port; Creality software / LightBurn / LaserGRBL must be closed.
- Some newer models (A1 Pro, A1C, T1) also expose Wi-Fi/HTTP control (LightBurn's "Creality Falcon HTTP" flavour). Undocumented and immature. **USB serial is the primary route.**
- **Camera access is model-dependent:**
  - Falcon 2 Pro and older camera models: separate USB UVC camera, readable with OpenCV.
  - Falcon A1 Pro (and likely A1C AI Camera): camera is **network-only**, undocumented protocol. Would need reverse-engineering or a spec from Creality.
- Air assist: usually `M8`/`M9`, but support varies by model. Some have automatic air assist that may not respond to G-code. Must be verified per machine.
- Diode lasers generally cannot cut clear or blue acrylic.

## 5. Coordinate system

- **Internal units: millimetres, floating point**, everywhere.
- Four spaces:
  - **Design** (mm, Y-up): each object's original geometry, never mutated.
  - **Bed** (mm, Y-up, origin = machine origin from the machine profile): placement, bounds checks, G-code.
  - **Screen** (px, Y-down): rendering and input.
  - **Camera** (px, Y-down): live view and alignment.
- Transforms:
  - Design → Bed: per-object affine matrix. Edits change the matrix, not the geometry (non-destructive, simple undo).
  - Bed → Screen: zoom/pan plus Y flip. **Centralise in one function.**
  - Camera → Bed: homography from calibration (later phase).
- G-code is always absolute: every job starts `G21` (mm) and `G90` (absolute). **Never use `G92`.** Server outputs bed coordinates directly.
- Bed size and origin corner come from each laser's machine profile. Verify by homing and jogging; never assume.
- Job origin modes: **Absolute** (default; required once camera is calibrated) and **Current position** with a 9-point anchor selector.
- DXF import: read `$INSUNITS`, convert to mm. If missing, ask the user (mm vs inch). Normalise the design's bounding box bottom-left to (0,0), then place on the bed.

## 6. Operations, presets and G-code

### Operations
Only two layer types. **No engraving** (no fill, raster or dithering).

| Layer | Kerf compensation | Order | Air assist default |
|---|---|---|---|
| **Score** | None | First | Off (configurable) |
| **Cut** | Yes | Second | On |

Layers are assigned by imported DXF layer/colour **and** by selection, because Onshape DXFs often put everything on layer `0`.

### Cut order
1. All Score paths first, travel-optimised (nearest-neighbour).
2. Cut paths **inside-out**: inner contours/holes before the outline containing them (containment test).
3. Travel-optimised within each nesting level.
4. Multiple passes: complete all passes of one shape before moving on.

### Kerf compensation
- Kerf width (mm) stored per material preset.
- Closed outer contours offset **outward** by kerf/2; holes offset **inward** by kerf/2.
- Applied only to closed Cut paths. Open Cut paths are left as drawn, with a warning.
- Preview shows the drawn line and the actual laser path.

### Material presets
- Pupils **select a material**; all settings follow automatically.
- Fields: material + thickness, sheet size, sheet cost (SAR), kerf, Cut settings (power %, speed mm/s, passes, air assist), Score settings (same fields).
- **Per-laser overrides** on top of a base preset. Resolved when a job is assigned to a station.
- Roles:
  - Pupils: select only; settings visible but locked.
  - Teachers: create/edit presets and overrides.
- Every job records the **preset version** used.
- Untested material/laser combinations are flagged; a teacher must run a test grid first.
- Station confirmation before run: "Load: <material>".
- Unit conversion at output: `F` = mm/s × 60; `S` scaled to each laser's `$30` value, read by Cutter, never assumed.

### G-code
- Keep arcs as arcs; output `G2`/`G3`. Flatten Béziers/splines to lines/arcs only at output.
- Laser mode `$32=1` must be enabled.
- Laser off (`S0`) across tabs and travel moves.

## 7. Kerf Server — features

### DXF import clean-up pipeline (runs automatically, in this order)
1. Normalise: snap to tolerance (default 0.01 mm, adjustable); consistent segment orientation.
2. Exact dedupe: hash normalised segments, drop repeats (including reversed duplicates).
3. Collinear merge: group lines by angle + perpendicular offset, union overlapping 1D intervals.
4. Arc merge: group by centre + radius, union angular intervals.
5. Curves: compare by sampled points within tolerance.
6. Remove micro-segments (< ~0.05 mm).
7. Score/Cut conflict: same line on both → keep Cut.
8. **Auto-join** into closed paths within tolerance.
9. Report counts ("Removed 37 duplicates, merged 12 overlaps, joined into 8 closed shapes, 1 open path") and support highlighting changes.

Dedupe/merge must run **before** join. **Shared edges** between touching parts are kept separate when kerf compensation is on. Optional "common-line cutting" toggle trades precision for speed.

Open paths on the Cut layer block submission, or warn and are treated as no-kerf.

### Other Server features
- G-code generation per section 6.
- **Duration estimate:** simulate GRBL motion (trapezoidal acceleration, cornering, rapids) using each laser's `$` settings. Target ±10%. Compare actual run times logged by Cutter against estimates and apply a per-laser correction factor. Feeds queue ETAs.
- **Material wastage:** part area (closed outer Cut contours minus holes), sheet area used (bounding box), % used, reusable offcut, optional cost per job.
- **Material test grid generator:** power × speed matrix of small cut squares with **scored labels** (single-line font). Score-only variant. Kerf test (slot-and-tab at set widths). Results saved directly as a preset.
- Job queue with teacher approval, per-station assignment, job history per pupil (designs, settings, run time; portfolio evidence).
- Log ingestion from Cutters, remote log-level control, diagnostic bundle requests.
- Image trace (Potrace, e.g. `potracer`) producing Score/Cut vectors only (later phase).

Suggested stack (confirm in plan): FastAPI, PostgreSQL, `ezdxf`, `shapely`/`pyclipper`.

## 8. Kerf Editor — features

Stack: TypeScript PWA; `paper.js` (geometry, intersections, hit-testing); `opentype.js` (text to paths).

**Geometry model:** paths made of line, arc and cubic Bézier segments. Arcs stay true arcs.

### v1
- Import DXF (via Server clean-up); layer assignment (Score/Cut) by layer, colour or selection.
- Core edits: select, move, rotate, scale, mirror, delete, duplicate, undo/redo, snap to grid, measure.
- Shapes: rectangle, rounded rectangle, circle, ellipse, polygon, star, line.
- Text converted to paths; single-line fonts for scoring.
- Array/grid copies.
- Tabs (bridges): auto N per closed shape at set width, or click to place.
- Repair tools: join (auto + manual), close path, convert to path, explode, node move/add/delete.
- Snapping: endpoints, midpoints, intersections, arc centres, grid; snap indicator; key to disable.
- Material selection; settings displayed but locked for pupils.
- Toolpath preview/simulation, showing cut order, travel moves, and flagging any path cut more than once.
- Duration estimate and wastage display.
- Bed outline always visible; out-of-bounds objects shown red and block submission.
- Rulers (mm), live cursor X/Y, numeric X/Y/W/H/rotation fields with anchor selector.
- Export edited design to DXF/SVG.

### v2
- Booleans (union, subtract, intersect).
- Trim, extend, split, fillet/chamfer, offset, segment-type conversion (line ↔ arc ↔ curve).
- Box maker (W×H×D + thickness → finger-jointed panels), living hinge.
- Auto-nesting.
- Thickness check: warn if joints don't match the selected material.

**Pedagogical caution:** heavy editing may displace Onshape CAD skills. Leroy may cap pupil editing.

### Station mode
- Job queue for that station; "Load material" confirmation; frame (laser off) required before run; Ignite/start, pause, resume, stop.
- Large stop button → `!` then `0x18`.
- Live camera view.
- Diagnostic bundle button.

## 9. Kerf Cutter — features and logging

### Deployment
- Portable folder (section 3): embeddable Python + dependencies + Cutter source + `run_cutter.bat`.
- Configuration (station name, COM port, server URL) in a plain config file inside the folder, preserved across updates.

### Responsibilities
- Serial connection, GRBL streaming, status polling, realtime commands.
- Read `$$` (including `$30`, `$32`, acceleration, max rates, bed size) and report to Server.
- Camera capture: monitoring feed as JPEG frames at ~5–10 fps over the outbound WebSocket (WebRTC later if needed).
- Bounds check before streaming.
- On any fault or connection loss: feed hold + reset.

### Logging (heavy, by design)
- Structured **JSON lines**: `timestamp` (ms), `level`, `station`, `job_id`, `event`, plus details.
- Categories:
  - **Raw serial TX/RX**: every line.
  - GRBL state and alarms/errors, decoded.
  - Connection events.
  - Job lifecycle (line N of M, estimated vs actual duration).
  - Camera events.
  - Network events.
  - Environment (OS, Python/Cutter version, COM ports with USB IDs).
- Local rotating files (e.g. 10 × 10 MB) that survive network outages; queued and shipped to Server when connected.
- Levels `DEBUG` (raw serial) / `INFO` / `WARNING` / `ERROR`. **Remote level control from Server.**
- **Diagnostic bundle** (button in station mode + command from Server): zip of recent logs, `$$` dump, firmware banner, Cutter config, COM ports, camera list, network test.

## 10. Camera

- **Monitoring** (earlier phase): live view for supervision. Supplements, never replaces, a supervising adult.
- **Alignment** (last phase), in OpenCV:
  - Lens calibration (checkerboard, once per camera).
  - Bed mapping: laser burns 4+ reference marks; compute homography.
  - Per job: still → undistort → warp to top-down bed view → Editor background at true scale.
  - "Verify" function: burn one dot, check position.
- Approach depends on model: USB UVC (easy) vs network-only (reverse-engineering).
- Camera points at the bed only. Clear with the school's safeguarding/data policy.

## 11. Safety

- Lasers are never left unattended. Remote view is supplementary only.
- Hardware flame sensors (or the laser's own) for fire detection. Vision-based flame detection is unreliable.
- Software interlocks: bounds check, mandatory frame before run, material confirmation, big stop button, stop on disconnect.
- All non-cutting test/jog operations run with the laser at `S0`.

## 12. Repository structure and Claude Code workflow

One repository. **Features are built in git worktrees on local feature branches, then merged into `main` and pushed to `origin`** (solo developer; no pull requests; see section 0, item 7). Parallel sessions per component are allowed, each in its own worktree; because each session owns its own folder, rebases onto `main` should be clean. Only one feature at a time may change `shared/`.

```
kerf-sabre/
  CLAUDE.md        architecture, names, coordinate rules, ownership rules, test commands
  docs/BRIEF.md    this document
  shared/
    CLAUDE.md      schema rules: versioned, changelog, no silent breaking changes
    job.schema.json, preset.schema.json, machine-profile.schema.json, api contract
  editor/          Kerf Editor (CLAUDE.md: TS/PWA conventions, tests)
  server/          Kerf Server (CLAUDE.md: Python conventions, tests)
  cutter/          Kerf Cutter (CLAUDE.md)
  spike/           Step 1 connectivity spike (throwaway)
  fixtures/dxf/    real Onshape DXF exports, incl. duplicates and open paths
```

**Rules for root `CLAUDE.md`:**
- Each feature in its own worktree and local feature branch. On completion: pull `main`, rebase the feature onto it, merge into `main` (fast-forward preferred), push `main` to `origin`, then remove the worktree and branch. Never open pull requests.
- Each session edits only its own folder.
- `shared/` changes require a version bump and a changelog entry.
- Units mm; Y-up bed space; absolute G-code; no `G92`.
- Pupil IDs only in logs.

**Optional:** a custom review subagent in `.claude/agents/` that checks diffs against the schema and coordinate rules.

**Where work runs:**
- The repo is **`kerf-sabre`** on GitHub (private). Editor and Server development and tests can run in Claude Code cloud sessions.
- The spike and Cutter **cannot run in the cloud**: they need physical USB access to a laser. Cloud sessions build and unit-test them (with a mocked serial port), and assemble the portable Windows folder. Leroy runs them on the station PCs and commits the resulting report folders back into the repo (`spike/results/<station>/`) for review.
- Deploying Server to Leroy's VPS is done from a local or SSH Claude Code session, not a cloud session.

## 13. Build order

Two tracks run **in parallel from day one**. Track B never waits for Track A.

### Track A — Machine (gated on hardware)
1. **Kerf Cutter Spike**: prove connectivity on the real station PCs (section 14).
2. **Kerf Cutter** (production), built from spike findings. Starts only after spike results from all 4 PCs are reviewed.
3. Editor station mode + camera monitoring.
4. Camera alignment.

### Track B — Design (independent of the lasers)
1. **Shared schemas + API contract**, with placeholder machine profiles.
2. **Server**: DXF clean-up, G-code generation, presets, duration, wastage, test grid.
3. **Editor design mode**: the standalone pupil editor. Import, clean-up, edit, layer assignment, preview, and **export DXF / SVG / G-code**.
4. Job submission and queue (only useful once Track A delivers, but buildable now).
5. v2 Editor features.

### Convergence
Integration of the two tracks happens when Track A step 2 is done: real machine profiles replace the placeholders, and the queue connects to the Cutters.

### Standalone value
After Track B step 3, pupils have a working free editor whatever happens on Track A: they can clean up Onshape DXFs, edit, and export G-code for SD-card use or files for any laser software. If direct machine control proves impossible, the project still delivers this.

## 14. Track A step 1 — Kerf Cutter Spike

**Purpose:** a minimal, throwaway prototype that runs on a station PC and proves we can send commands to the laser, receive responses, and access the camera. Leroy runs it on each of the 4 PCs and brings the output folders back for review.

### Form
- Single Python file `spike/spike.py`. Dependencies: `pyserial` (required), `opencv-python` (**optional**).
- **Deliverable: a portable zip folder**, assembled by a build script in `spike/` that can run on Linux (in a cloud session):
  ```
  kerf-spike/
    python/          Windows embeddable Python (python.org zip) with pyserial + opencv
                     installed into it (download Windows wheels; configure the ._pth file
                     so site-packages is found)
    spike.py
    run_spike.bat    double-click launcher: uses .\python\python.exe, keeps window open at end
    README.txt       plain-English steps for the operator
  ```
- No installation, no admin rights, no registry changes. Must run from a local folder or a USB stick.
- Pin the Python version and wheel versions; target Windows 10/11 64-bit.
- Terminal only. Configurable port, baud (default 115200), station name and server URL via CLI args or prompts.
- If `cv2` fails to import, the spike **does not crash**: test 9 is marked "skipped: OpenCV unavailable", with the import error recorded.
- Unit tests in the repo use a mocked serial port, so the sequence logic can be tested in a cloud session.

### Modes
1. **Auto test**: runs the full sequence unattended (except where operator confirmation is required) and writes a report.
2. **Console**: type any GRBL command and see the raw reply, with logging still active.

### Auto-test sequence

| # | Test | Pass if |
|---|---|---|
| 1 | List serial ports with USB VID/PID and descriptions | A CH340-type port is found (auto-select if exactly one; otherwise prompt) |
| 2 | Open port, wait for banner | `Grbl 1.1x` received within timeout |
| 3 | Send `$$` | Full settings returned, parsed and saved |
| 4 | Send `?` repeatedly | Status reports parse (state, MPos/WPos) |
| 5 | Home `$H` | Returns to `Idle`, no alarm (handle alarm/unlock `$X` cases and log them) |
| 6 | Jog 10 mm X/Y and back (`$J=`), laser off | Reported position matches commanded within tolerance |
| 7 | Air assist `M8` then `M9` | Operator confirms y/n |
| 8 | Feed hold `!`, resume `~`, soft reset `0x18` during a slow jog | Correct state transitions observed |
| 9 | Camera probe: enumerate OpenCV camera indices | A camera opens and `camera.jpg` is saved, **or** record "no USB camera found (possibly network-only)" |
| 10 | Outbound HTTPS request to the configured server URL | Connection succeeds (record status/latency/error) |
| 11 | **Optional laser fire**: 10 mm square at ≤5% power | Runs **only** after a typed confirmation phrase; **skipped by default** |

### Rules
- A failed test is logged and the sequence **continues**. Tests that depend on an earlier failure are marked "skipped (dependency)".
- Laser at `S0` in every step except test 11.
- Ctrl-C or any exception → send `!` then `0x18`, close the port cleanly, still write the report.
- Clear operator prompts; readable for a non-developer.

### Output (one timestamped folder per run, named by station)
- `report.json`: per-test pass/fail/skipped, details, durations, errors.
- `report.txt`: human-readable summary.
- `serial.log`: every TX/RX line with millisecond timestamps (JSON lines).
- `settings.txt`: raw `$$` dump.
- `camera.jpg`: if captured.
- `env.txt`: OS, Python/exe version, spike version, port list with USB IDs, camera indices tried.

## 15. Open questions (spike and IT will answer)

1. Exact Falcon model(s) of all 4 lasers.
2. Camera: USB UVC or network-only, per laser.
3. Air assist: does `M8`/`M9` work, per laser?
4. Bed size, origin corner, `$30` value, homing behaviour, per laser.
5. Is the CH340 driver installed on the station PCs?
6. Does application whitelisting (e.g. AppLocker) or antivirus block a portable `python.exe` run from a user folder or USB stick? If so, can IT allow-list the folder?
7. Does the school network allow outbound WebSocket/HTTPS from station PCs to Leroy's server?
8. Which materials are used, and can these lasers cut them (acrylic colour)?
