# shared/ changelog

Schemas and the API contract are versioned together. Breaking change = major bump + migration note.

## 0.2.0 - server contract (additive)
Everything below is additive. The only change to existing data is the `schemaVersion` constant: set it to `0.2.0`.
- `openapi.yaml`:
  - Auth: `GET /auth/me`; roles are `pupil`, `teacher`, `station`.
  - DXF: `/dxf/cleanup` now assumes **centimetres** when `$INSUNITS` is missing (the Onshape default); `unitsOverride` accepts `mm`, `cm`, `inch`; the result reports the units used. New `POST /jobs/from-dxf` saves a cleaned DXF as a draft job.
  - Jobs: `PUT /jobs/{id}` (replace a draft), `POST /jobs/{id}/submit`, `/reject`, `/cancel`; approve takes an optional `station`.
  - Station flow: `POST /jobs/{id}/frame`, `POST /jobs/{id}/assign` (now requires `materialConfirmed`), `GET /stations`, `GET /stations/{id}`, `POST /stations/{id}/control`, `GET /stations/{id}/camera`, `GET /stations/{id}/logs`, `POST /stations/{id}/diagnostics/upload`.
  - Cutter WebSocket: new `CutterAck` and `CutterJobResult` messages; `run_job` and `control` carry `totalLines`, `estimatedS`, `bounds`, `jobId`; `hello` may carry `grblBanner`.
- `job.schema.json`: optional `source`, `warnings`, `statusReason`; `tabs.atLengthMm` is now defined (bed-space length from the object's start).
- Data schemas otherwise unchanged. Editor presets (`editor/src/presets.ts`) moved to `0.2.0` with this release.

## 0.1.0 - initial draft
- `machine-profile.schema.json`, `preset.schema.json`, `job.schema.json`.
- `openapi.yaml` API contract (REST + Cutter WebSocket envelope).
- Placeholder machine profiles for stations 1-4 (values unverified; replace from spike results).
