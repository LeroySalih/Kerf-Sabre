# shared/ changelog

Schemas and the API contract are versioned together. Breaking change = major bump + migration note.

## 0.2.25 - file names, delete, and open tabs that follow the person (additive)
- `job.schema.json`: optional `name` (the pupil's title for a file, at most 60 characters). The Server stores and returns it.
- `openapi.yaml`: `PUT /jobs/{jobId}/name` renames a file in any state (owner only); `DELETE /jobs/{jobId}` deletes a draft, cancelled, rejected or failed file (owner only; `409 in_queue` while it is waiting or on a laser, `409 keep_record` for a finished cut, `409 handed_in` for work handed in for an activity; its G-code and history go with it).
- `openapi.yaml`: `GET /workspace` and `PUT /workspace`: the files a person has open in the Editor (tab order, tab names, the one showing), kept per person on the server so another browser shows the same tabs after signing in. Only the caller's own, still existing files are kept or returned; at most 30.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.25`.

## 0.2.24 - another laser takes over a file (additive)
- `openapi.yaml`: `POST /jobs/{jobId}/take` (teacher, admin, technician; body `{station}`): a waiting (`approved`) file that was assigned to, or being framed on, another laser becomes this laser's. It keeps its place in the queue; a frame made on the other laser is forgotten, so it must be framed again here. `409 not_approved` for a file that is not waiting. Event `taken_over` records from/to.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.24`.

## 0.2.23 - disconnect a Cutter from the Station page (additive)
- `openapi.yaml`: `POST /stations/{stationId}/disconnect` (teacher, admin, technician): closes the Cutter's WebSocket with code **4001**; the Cutter stays disconnected until someone starts it again. `409 station_offline` when none is connected, `409 station_busy` while it is cutting or not idle.
- WebSocket close codes the Cutter must **not** reconnect after: `4000` (another Cutter connected as this laser and replaced it), `4001` (disconnected by staff), `4401` (token refused), `4403` (new: a Cutter that says it is a different laser than its token's; each station token is for one laser). Any other drop still reconnects.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.23`.

## 0.2.22 - Cutter kinds named by laser (rename)
- `openapi.yaml`: the Cutter download `kind` value `real` is now **`creality-falcon`** (the Creality Falcon Cutter, which drives Falcon lasers over GRBL). `practice` is unchanged. `GET /cutter/kinds` is keyed by the new value, `POST /cutter/package` takes and returns it, and the download is `kerf-cutter-creality-falcon.zip` (the build still makes `cutter/build/kerf-cutter.zip`). A later Cutter for another laser type (the GCC Mercury III) gets its own value.
- **Migration:** only the Admin site used `kind`; it moves to the new value in the same change. Any other caller sending `kind: "real"` now gets `422 invalid`.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.22`.

## 0.2.21 - staff see pupils' names (additive)
- **Privacy rule change (decided by the school):** Kerf now keeps a display *name* for a signed-in person, taken from DINO's `userinfo` (`name`, `profile` scope) when they sign in. Never an email. It is shown to **staff of the same school only** (teacher, admin, technician), never to other pupils, never in logs, and deleted when the pupil is removed from a class. Everything else still uses IDs.
- `openapi.yaml`: new `POST /auth/profile` (any DINO sign-in; the server asks DINO itself with the caller's token and stores the name; `{name}` or `{name: null}`, never an error if DINO cannot be reached). Optional `pupilName` on `QueueEntry` and on job lists for staff, `displayName` on class pupils and the progress grid.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.21`.

## 0.2.20 - a technician rejects a queued file with a note (additive)
- `openapi.yaml`: `POST /jobs/{jobId}/reject` also accepts a technician, for a file that is `approved` (waiting in the queue); `409` for one still waiting for approval. The job's `statusReason` is `Rejected at the laser: <note>`. Taking a file ahead of the queue is the existing `skipQueue` flag, which a technician may now use.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.20`.

## 0.2.19 - DINO is the only way in; technician role (additive)
- `openapi.yaml`: new role `technician` (from a DINO token's `roles`; admin > teacher > technician > pupil). A technician runs the laser stations and nothing else: the station endpoints (queue, frame, placement, start, pause/resume/stop, camera, camera calibration and calibration marks, `skipQueue`) accept it, every teacher/admin endpoint refuses it. `Me.role` and the role lists include it.
- A running server is **DINO-only** (`KERF_AUTH_MODE=planner`, now the default; it needs `KERF_SSO_ISSUER`). Stored tokens for pupils, teachers and admins stop working (401), `POST /auth/login` (class code + PIN) answers `404 sso_only`, `POST /staff` and `kerf-admin create-token` only make `station` tokens, `POST /schools` takes no `adminId`. The Cutter's station token and the platform owner's token are the only stored tokens left. `pins` and `both` remain as test and local-development modes.
- Editor and Admin: no class code + PIN form, no pasted-token sign-in, no PINs. A technician sees only a "Station pages" page on the Admin site; an admin also has it. `/?station=<laser>` opens that laser's Station page.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.19`.

## 0.2.18 - sign in with planner-004 (additive)
- `openapi.yaml`: bearer tokens may also be a planner-004 (DINO) JWT for pupils, teachers and admins (never stations or the platform). New public `GET /auth/config` (`mode` = `pins`, `planner` or `both`, plus the OAuth endpoints and client IDs the Editor and Admin need for Authorization Code + PKCE). `POST /auth/login` answers `404 sso_only` when the server only accepts planner-004 sign-in. `Me` now lists every role and carries `school`.
- Pupil IDs stay IDs only: a planner-004 sign-in uses the DINO user ID (`sub`) as the person's ID; names and emails are never stored or logged. Design: `docs/AUTH-PLANNER-004.md`.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.18`.

## 0.2.17 - a new send replaces the old one (additive)
- Behaviour: when a pupil submits a file, their earlier files that are still waiting (`submitted` or `approved`) are cancelled with the reason "Replaced by a newer file (job-...)". The new file takes a new ticket at the back of the queue: the old place is not kept. A file already on a laser (`assigned`, `running`) and drafts are never touched, and a send that fails validation cancels nothing. An activity hand-in that pointed at the replaced file now points at the new one.
- `openapi.yaml`: `JobReceipt.replaced` lists what a submit replaced (`id`, `ticket`).
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.17`.

## 0.2.16 - ignore layer (additive)
- `job.schema.json`: `objects[].layer` also accepts `ignore` (drawn in dark grey in the Editor). An Ignore shape is kept in the file but is never cut or scored: the Server leaves it out of the G-code, the estimate, the design size, the fit check and the material use, and a job with only Ignore shapes is refused ("nothing to cut"). The Editor leaves it out of DXF/SVG export and does not require it to be on the bed. Nothing changes for the Cutter, which only receives G-code.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.16`.

## 0.2.15 - design size in the queue (additive)
- `job.schema.json`: `estimate.extentMm` (`widthMm`, `heightMm`): the size of the design itself (the box around everything cut or scored, before kerf compensation), not the bed.
- `openapi.yaml`: `QueueEntry.extentMm` carries it, so a teacher approving a file, and a station's queue, can see how big each design is. The Server fills it in when it checks a job; older jobs have none.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.15`.

## 0.2.14 - stations on the Admin site (additive)
- `openapi.yaml`: `DELETE /machines/{machineId}` (school admin) removes a laser, its camera calibration and its station tokens; refused with `station_online` while its Cutter is connected and `station_in_use` while files are queued for it or being cut. `PUT /machines/{machineId}` with a new ID already added a laser; that is now documented. `GET /cutter/kinds` (school admin) says which Cutter downloads are on offer. `POST /cutter/package` takes `kind` (`practice` default, or `real`; `real` answers `409 cutter_not_built` until it has been built) and answers `kind: practice|real`.
- **Rename (Admin site only):** the response `kind` value `pretend` is now `practice`, and the practice download is `kerf-cutter-practice.zip`.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.14`.

## 0.2.13 - dotted lines (additive)
- New optional `dashMm` (mm, `0` or at least `0.1`; default `0` = solid line): the length of each dash and of each gap along a path, so a Score or Cut line can be dotted. Laser on for `dashMm`, off for `dashMm`, starting on at the path's start and restarting on every pass. It is set per shape in the job's `objects[].settings`, or as the material default in a preset's `cut` / `score` operation and `laserOverrides` patches. A per-shape value beats the material's. Tabs on a Cut outline stay uncut; the dashes only switch the laser off in more places.
- Server: the G-code emitter splits the path at each dash boundary and moves the gaps with `S0` (same as tabs). The Editor has no control for it yet.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.13`.

## 0.2.12 - real machine profiles (additive)
- `machine-profiles/`: the four placeholder profiles are replaced by the values measured in the spike (`docs/spike-results.md`, `spike/results/*/settings.txt`): stations 1 and 2 have a 400 x 415 mm bed, stations 3 and 4 a 355 x 390 mm bed (`$130`/`$131`), `$30` 1000, laser mode on, homing on, acceleration 1000 (stations 1, 2) or 500 (stations 3, 4) (`$120`/`$121`), max rate 8000 mm/min (the lower of `$110` 25000 and `$111` 8000), air assist M8 verified, USB UVC camera. Files renamed `station-N.json`; `placeholder` is now `false`. **Still assumed:** `originCorner` front-left (the spike did not check where the machine origin is), and `model` (null until the Falcon models are confirmed). Stations 3 and 4 also have a 38 mm Z axis; the profile has no field for it yet.
- Server: a database made with the placeholders gets the new profile on start-up unless a teacher already edited it (its `placeholder` is false) or it has a camera calibration to keep.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.12`.

## 0.2.11 - Cutter download (additive)
- `openapi.yaml`: `POST /cutter/package` (school admin; body `{station}`) makes a new station token for one of the school's lasers (returned once) and a download link valid for an hour, answering `{station, token, kind, downloadPath, fileName, expiresAt}`. The link (`GET /downloads/cutter/{link}/{name}`) needs no Authorization header (a browser link cannot send one) and the zip it serves holds no token. `kind` is `pretend` until the real Cutter exists: the package is then the pretend Cutter (`fake_cutter.py`), which connects like a laser but cuts nothing.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.11`.

## 0.2.10 - calibrate from squares the laser cuts (additive)
- `openapi.yaml`: `POST /stations/{id}/calibration-marks` (teacher) makes a job of 1 or 4 known squares (`centerX`, `centerY`, `sizeMm`, `spacingMm`, `layer` score or cut, `presetId`), pinned to that laser and already approved, and returns `{jobId, squares}` with each square's corners in bed mm in the order to click them. The teacher cuts it (Frame and Start with `skipQueue`, `allowUntested`) and clicks the corners in the camera picture, so the camera can be calibrated when the bed is bigger than the picture. `camera-calibration` now accepts 4 to 64 points (4 are fitted exactly; more by least squares). `GET /stations` carries `calibrated`.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.10`.

## 0.2.9 - camera alignment (additive)
- `openapi.yaml`: **camera calibration** per laser: `GET/PUT/DELETE /stations/{id}/camera-calibration` (a laser PC or teacher reads, a teacher writes; 404 `not_calibrated` until done). It stores the camera picture size, the four bed corners as clicked in the picture, and the camera-pixel -> bed-mm homography (row-major 3x3); the server re-projects the points and refuses a matrix that does not map them. **Placement**: `POST /jobs/{id}/placement` takes `station` and `matrix` (a rigid 2x3, move and turn only) which is applied to every object's matrix; the job becomes `absolute`, must still fit the bed, the earlier Frame is cleared, and only the job whose turn it is can be placed (a teacher may `skipQueue`).
- This is the first, approximate calibration (four clicked corners). The brief's accurate version (lens undistort + burned reference marks) can later replace the stored matrix without changing these endpoints.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.9`.

## 0.2.8 - schools (additive)
- `openapi.yaml`: **schools**. Every class, pupil, activity, file, laser, queue and material list belongs to one school, and nobody in a school can see or change another's (another school's class, file, laser or material answers 404). New roles: `admin` (everything in their school, including every teacher's classes, and managing staff) and `platform` (creates schools and their first admin; sees nothing inside a school). `GET/POST /schools` (platform), `GET /school`, `GET/POST /staff` and `DELETE /staff/{id}` (school admin: teachers, other admins and station tokens; a token is shown once). `GET /auth/me` now includes `school`. `ClassInfo` is unchanged.
- Class codes, pupil IDs and laser (station) IDs stay unique across the whole server (a pupil types the class code at login; a laser ID is also its station ID), so the second school to ask for a taken one is told to choose another. A station token can only connect as a laser registered to its own school. Material presets are per school: each new school starts with the placeholder list and edits its own.
- Databases made earlier move into a default school `main` on start-up (presets are rebuilt with a school key; nothing is lost).
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.8`.

## 0.2.7 - approval per class (additive)
- `openapi.yaml`: `ClassInfo.requireApproval` (default true). `POST /classes` takes it, and the new teacher endpoint `PUT /classes/{code}` changes it (and the label). When a class does not require approval, a pupil's submitted file goes straight into the queue (`approvedBy: auto`); otherwise it waits for a teacher as before. Files already waiting are not changed. Classes made before this gain the column as "requires approval".
- The server-wide `KERF_REQUIRE_APPROVAL=false` still switches approval off for everyone.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.7`.

## 0.2.6 - copy activities (additive)
- `openapi.yaml`: `POST /classes/{code}/activities-copy` copies activities from another of the teacher's classes (or duplicates within the class). Copies start hidden and without due dates; pupils' work and feedback are not copied.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.6`.

## 0.2.5 - activities and feedback (additive)
- `openapi.yaml`: teachers set **activities** for a class (`/classes/{code}/activities`, order, publish, archive) and see **progress** (`/classes/{code}/progress`), a pupil's work and files, and give **feedback** (`comment`, `revise`, `complete`). Pupils see their class's published activities (`/activities`) with status and feedback and hand in a file (`/activities/{id}/submit`). `ClassInfo.teacherId`: a class belongs to the teacher who created it; other teachers cannot see or change it (a class with no owner is shared).
- `job.schema.json`: optional `activityId` (the activity a file is for; the server checks the pupil's class has it).
- Server: databases made by an earlier version gain new columns automatically on start-up.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.5`.

## 0.2.4 - class login (additive)
- `openapi.yaml`: `POST /auth/login` (class code + pupil ID + PIN -> short-lived token), `POST /auth/logout`, teacher endpoints `GET/POST /classes`, `GET/POST /classes/{code}/pupils`, `DELETE /classes/{code}/pupils/{pupilId}`, `POST /pupils/{pupilId}/reset-pin`. Bearer tokens (teachers, stations, existing pupil tokens) keep working unchanged.
- Pupils are still identified by ID only; no names are stored. PINs are hashed.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.4`.

## 0.2.3 - station progress (additive)
- `openapi.yaml`: `Station.progress` (job id, line, total lines, estimated and actual seconds) so Station mode can show how far a cut has got.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.3`.

## 0.2.2 - ticket queue (additive)
- `openapi.yaml`: `GET /queue` (ordered ticket queue, `QueueEntry`), `POST /queue/{jobId}/move` (teacher reorders), `POST /jobs/{jobId}/defer` (let others go first); `assign` takes teacher-only `skipQueue` and can answer `not_your_turn`; `JobReceipt` carries `ticket` and `position`.
- `job.schema.json`: optional `ticket`.
- Behaviour: approved jobs are served first in, first out; a station can only frame or start the job that is next for it.
- `schemaVersion` constants, `info.version`, Editor documents moved to `0.2.2`.

## 0.2.1 - dimensions (additive)
- `job.schema.json`: optional `dimensions` array (linear and radial dimension annotations). They exist so a design can be read at a glance in the Editor and are saved with the job; the Server stores them and never uses them for G-code, estimates or bounds, and they are never sent to the Cutter.
- Every schema's `schemaVersion` constant, the OpenAPI `info.version` and Editor presets/job documents moved to `0.2.1`.

## 0.2.0 - server contract (additive)
Everything below is additive. The only change to existing data is the `schemaVersion` constant: set it to `0.2.0`.
- `openapi.yaml`:
  - Auth: `GET /auth/me`; roles are `pupil`, `teacher`, `station`.
  - DXF: `/dxf/cleanup` now assumes **centimetres** when `$INSUNITS` is missing (the Onshape default); `unitsOverride` accepts `mm`, `cm`, `inch`; the result reports the units used. New `POST /jobs/from-dxf` saves a cleaned DXF as a draft job.
  - Jobs: `PUT /jobs/{id}` (replace a draft), `POST /jobs/{id}/submit`, `/reject`, `/cancel`; approve takes an optional `station`.
  - Station flow: `POST /jobs/{id}/frame`, `POST /jobs/{id}/assign` (now requires `materialConfirmed`), `GET /stations`, `GET /stations/{id}`, `POST /stations/{id}/control`, `GET /stations/{id}/camera`, `GET /stations/{id}/logs`, `POST /stations/{id}/diagnostics/upload`.
  - Cutter WebSocket: new `CutterAck` and `CutterJobResult` messages; `run_job` and `control` carry `totalLines`, `estimatedS`, `bounds`, `jobId`; `hello` may carry `grblBanner`.
- `job.schema.json`: optional `source`, `warnings`, `statusReason`; optional per-object `settings` (power/speed/passes override, used by material test grids); `tabs.atLengthMm` is now defined (bed-space length from the object's start).
- Data schemas otherwise unchanged. Editor presets (`editor/src/presets.ts`) moved to `0.2.0` with this release.

## 0.1.0 - initial draft
- `machine-profile.schema.json`, `preset.schema.json`, `job.schema.json`.
- `openapi.yaml` API contract (REST + Cutter WebSocket envelope).
- Placeholder machine profiles for stations 1-4 (values unverified; replace from spike results).
