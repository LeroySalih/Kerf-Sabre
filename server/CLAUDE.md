# server/ (BISAK Kerf Server)
Python: FastAPI, SQLAlchemy (SQLite default, PostgreSQL via `KERF_DATABASE_URL`), ezdxf, shapely, jsonschema. Schemas and the API contract come from `shared/` (the server validates against them; `shared/tests` checks version agreement). Type hints, pytest. `README.md` documents the workflow and deployment.

## Layout
- `app.py` app factory (`/api/v1`, `/health`, optional Editor static mount). `config.py` KERF_* settings. `security.py` hashed bearer tokens, roles pupil/teacher/station. `admin.py` the `kerf-admin` CLI.
- `cleanup/` DXF clean-up in brief section 7 order (dedupe/merge before join). Entry `cleanup_dxf`.
- `gcode/` post-processor: `prepare` (matrices to bed space, arcs kept unless the matrix distorts them), `kerf` (kerf offset via shapely then arcs re-fitted; GRBL centre snapping), `order` (Score first, Cut inside-out), `emit` (G21/G90, no G92, G2/G3, tabs as S0 moves, passes, air), `estimate` (GRBL-style planner), `motion` (G-code parser used as a simulator in tests and as a safety check on our own output).
- `services_jobs.py` job lifecycle + validation; `services_run.py` frame/assign/finish/watchdog; `stations.py` live Cutter state, logs; `api/*` routers; `api/cutter_ws.py` the `/api/v1/ws/cutter` socket.

## Rules that bite
- Machine facts (bed, `$30`, air assist) come from machine profiles; the Cutter's reported `$30`/`$32` must match or the job is refused.
- Absolute G-code only, never G92. `current-position` jobs are translated by the server using the Cutter's reported position; the head must not move between Frame and Start.
- Never hold a DB session open while awaiting the Cutter (SQLite would lock); `services_run.start` does the work in two short transactions.
- Pupil IDs only, never names (uploaded file names are discarded). Camera frames stay in memory.
- Preset edits create new versions; jobs record the version used.
- Job `dimensions` (Editor annotations) are stored and returned with the job but never read by `gcode/`, validation, estimates or the Cutter messages.
