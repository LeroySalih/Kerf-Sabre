# BISAK Kerf Server

One server on one URL. It cleans pupils' DXF files, makes the G-code, keeps the queue, and tells the laser PCs when to cut.

## The flow

1. **Pupil sends a file.** From the Editor (or `POST /api/v1/jobs` / `POST /api/v1/jobs/from-dxf`). A DXF is cleaned on arrival (duplicates removed, overlaps merged, lines joined into closed shapes, cm assumed when the file has no units). The pupil gets a receipt with a plain-English clean-up summary, warnings and a time estimate. The job is a *draft*, or *submitted* if they sent it for cutting.
2. **Teacher approves** (`POST /jobs/{id}/approve`, optionally pinning a laser). Switch this off with `KERF_REQUIRE_APPROVAL=false` and submitted jobs go straight to the stations.
   Approval puts the job in the **ticket queue**: it gets the next ticket number and is cut in queue order (first in, first out). `GET /queue` shows the order (pupils see their own details and just the ticket number and place of others). A teacher can move a job (`POST /queue/{id}/move`: `front`, `back`, `up`, `down` or a `position`); a pupil who isn't ready can let others go first (`POST /jobs/{id}/defer`, to the back of the queue). Tickets never change or get reused.
3. **At the laser PC** (Editor in Station mode, signed in with the station's token) the pupil picks their file from `GET /jobs?status=approved`, puts the material on the bed and presses **Frame**. The server makes the G-code for *that* laser and tells the Cutter to trace the outline with the laser off. The pupil nudges the material until it lines up.
4. **Start.** The pupil confirms the material (`Load: <material>`) and presses Start (`POST /jobs/{id}/assign`). The server re-checks everything, sends `run_job` to the Cutter over its WebSocket, and waits for the Cutter's *ack*. The Cutter downloads the G-code and cuts, reporting progress and the result.

Interlocks (each returns a clear `409`/`422`): job must be approved and **next in the queue for that laser** (`not_your_turn`; a job pinned to another laser, or being lined up on another laser, doesn't hold this one up; teachers can `skipQueue`); station online, idle, laser mode on, `$30` equal to the machine profile; the job must have been framed on this station in the last 30 minutes and not moved since; the material must have been test-gridded on this laser (teachers can override); the design must fit the bed.

Origin: a job is either `absolute` (bed coordinates) or `current-position` (the anchor of the design goes where the laser head is when the job is framed and started).

## Class login

Pupils sign in with **class code + pupil ID + PIN** (no names anywhere, only IDs). The server issues a token that lasts `KERF_SESSION_HOURS` (default 10) and is revoked on sign-out. Five wrong PINs in a row lock that ID for five minutes; a wrong class, ID or PIN always gives the same message so nobody can find out which IDs exist; many failures from one computer slow it down. PINs are random 5-digit numbers, stored hashed (scrypt), shown once when made.

```bash
kerf-admin create-class --code 9B-DT --label "Y9 set 2"
kerf-admin add-pupils --class 9B-DT pupils.csv --out pins.csv     # one pupil ID per line (or a pupilId column); hand out pins.csv, then delete it
kerf-admin reset-pin --id P10234                                  # forgotten PIN; also clears a lockout and ends their sessions
```
Or use the **Classes** button in the Editor as a teacher, or the `/api/v1/classes` endpoints. Teachers and laser stations keep using tokens (`kerf-admin create-token`).

## Run it

```bash
cd server
python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
export KERF_EDITOR_DIST=../editor/dist     # optional: also serve the Editor (npm run build in editor/)
kerf-admin init-db
kerf-admin create-token --role teacher --id T001      # shown once
kerf-admin create-token --role station --id station-1 # put this in that laser's Cutter
kerf-admin import-pupils pupils.csv --out tokens.csv  # one token per pupil ID
kerf-server                                            # http://localhost:8000  (API docs: /api/v1/docs)
```

On a real URL use `deploy/` (Docker Compose + Caddy, automatic HTTPS) or `deploy/kerf-server.service` (systemd). Copy `deploy/.env.example` to `.env`, set `KERF_DOMAIN`, `docker compose up -d --build`, then create tokens inside the container: `docker compose exec kerf kerf-admin create-token ...`.

Everything is configured with `KERF_*` environment variables (see `deploy/.env.example` and `kerf_server/config.py`). Data (SQLite database, station logs, diagnostic bundles) lives in `KERF_DATA_DIR`; back that folder up.

## Try it without a laser

```bash
kerf-server &                                                    # the server (set KERF_EDITOR_DIST to serve the Editor)
python -m kerf_server.devtools.fake_cutter --token <station token> --station station-1   # a pretend Cutter
```
Open the Editor: sign in as a pupil and send a design; as a teacher (the **Queue** button) approve it; then sign in with the **station token** to get Station mode: Frame, tick the material, Start, watch it "cut" (`--speed` makes the fake Cutter faster than the estimate).

## Cutter connection

Each Cutter opens an **outbound** WebSocket to `wss://<server>/api/v1/ws/cutter` with `Authorization: Bearer <station token>` (or `?token=`). Messages are in `shared/openapi.yaml` (`CutterMessage`, `ServerMessage`). `tests/fakecutter.py` is a working reference client.

## Logs

Cutter log lines are kept in `KERF_DATA_DIR/logs/<station>.jsonl` (rotating), with the server's own decisions about that station written into the same file. Teachers read them at `GET /stations/{id}/logs`, change a Cutter's log level with `PUT /stations/{id}/log-level`, and ask for a diagnostic bundle with `POST /stations/{id}/diagnostics`. Logs carry pupil IDs, never names; camera frames are held in memory only.

## Tests

`pytest` from this folder. `tests/test_stations.py` runs whole cuts against a fake Cutter.
