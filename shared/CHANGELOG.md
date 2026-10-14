# shared/ changelog

Schemas and the API contract are versioned together. Breaking change = major bump + migration note.

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
