# BISAK Kerf Cutter: implementation plan

Status: plan for review. Inputs: `docs/BRIEF.md` (sections 3, 4, 9, 10, 11), `docs/spike-results.md` (all four stations pass), `shared/openapi.yaml` (`/ws/cutter`, `CutterMessage`, `ServerMessage`), `server/kerf_server/devtools/fake_cutter.py` (the pretend Cutter the real one replaces).

## 1. What the Cutter is
One Python process per station PC, started by `run_cutter.bat` from a portable folder. It owns the laser: serial link to GRBL, camera, job execution, logging. It opens one **outbound** WebSocket to the Server and listens on nothing on the network. Jobs run in this process, so closing a browser never interrupts a cut. Any fault or lost connection means feed hold then reset.

## 2. Facts from the spike that shape the design
- Controller is a native USB ESP32-S3 (VID 303A / PID 4001), Grbl 1.1f, not a CH340. COM numbers differ per PC and can change; each PC also has a non-GRBL AMT port (COM3).
- No banner on open. Send `0x18`, then read `[MSG:...]` and the `Grbl` banner.
- The USB "serial number" is `123456` on every unit, so it cannot tell two machines apart. The USB **location** (for example `1-5.1`) is stable while a cable stays in the same socket.
- `$J` jogs ignore feed hold; a normal `G1` honours it. `!` gives `Hold:1` (decelerating, head runs on about 0.4 mm at F60) then `Hold:0` (stopped). Position is only trustworthy at `Hold:0`.
- Soft reset mid-motion raises `ALARM:3` and may lose position: the Cutter must treat "reset" as "needs homing" before the next job.
- Two machine types: 355 x 390 mm with Z (stations 3, 4) and 400 x 415 mm without (stations 1, 2). Bed, `$30`, `$32`, acceleration come from `$$` plus the machine profile, never constants.
- Camera is a USB UVC device at OpenCV index 0 on each PC today; frames are dark and fisheyed.
- Air assist M8/M9 verified on all four.

## 3. Proposed structure (`cutter/`)
```
cutter/
  pyproject.toml            tests + tooling only; runtime deps are pinned in the build script
  kerf_cutter/
    __main__.py             `python -m kerf_cutter [--devices|--diag|--config PATH]`
    config.py               load/save cutter.json (station, server URL, token, device assignments, log levels)
    logs.py                 JSON-lines logger, rotating files, ship queue, remote level control
    devices/
      ports.py              enumerate serial ports (pyserial) + USB ids/location
      cameras.py            enumerate cameras with names (see 5)
      manager.py            discovery, probing, assignment, hot-plug watcher, status
    grbl/
      link.py               serial thread: send/ok, realtime bytes, status parsing (from spike `Link`)
      state.py              decoded state, alarms, errors, Hold:0/1, homed flag
      jobrun.py             stream a G-code file, bounds check, progress, pause/resume/stop
    camera/capture.py       capture thread, JPEG encode, frame rate limiter, never written to disk
    net/client.py           WebSocket client, reconnect with backoff, message dispatch
    net/http.py             G-code download (+sha256), diagnostic bundle upload (urllib, no extra deps)
    diag/bundle.py          zip: recent logs, `$$`, banner, config (token removed), ports, cameras, network test
    station.py              wires everything; the one state machine (see 6)
  tests/
    fake_grbl.py            simulated controller from spike observations (banner after reset, Hold:1->0, ALARM:3, $J ignoring hold)
    ...
  build_cutter.py           portable Windows zip (like spike/build_spike.py)
  run_cutter.bat
```
Runtime dependencies (bundled, nothing installed): `pyserial`, `websockets`, `numpy`, `opencv-python-headless` (smaller than the spike's full build), a camera-name enumerator. The stdlib covers HTTP and zip. Python 3.11 embeddable, as in the spike.

Concurrency: one asyncio loop for the network and the state machine; the serial link and camera run in their own threads and hand results over with thread-safe queues. Nothing on the loop blocks on serial.

## 4. Device management (requirement from review)
Goal: the operator can see and control which COM ports and cameras are connected and which are the laser and its camera, and a restart or a replug does not break that.

- **Discovery**: list serial ports (device, description, VID/PID, serial, USB location, hardware id) and cameras (index, friendly name, whether a frame was read). Re-run on demand and every few seconds in the background to notice plug/unplug.
- **Machine port**: probe each candidate (skip ones already held; skip known non-GRBL such as AMT/SOL): open, `0x18`, expect a `Grbl` banner within a few seconds, read `$$`, close. Never leave probes holding ports. Report "busy" distinctly (another program holds it) with a message naming LightBurn, LaserGRBL and Creality software.
- **Assignment** is saved in `cutter.json` as a *match rule*, not a bare COM name: `{vid, pid, location, lastPort}`. On start, try `lastPort` first; if it does not answer, find a port matching the rule; if none, probe all unassigned ports; if still ambiguous, do not guess: report `needs_attention` and wait for the operator. Same approach for cameras (friendly name plus index plus a frame check).
- **Pairing**: a station is a list of *units*, each `{machine, camera?}`. Day one there is one unit, but config, messages and logs carry a `unit` id so a second machine or camera does not need a redesign.
- **Operator interfaces**:
  1. `run_cutter.bat --devices`: a text menu (list, refresh, assign machine, assign camera, test connection, show a camera frame count without saving it). Needed first because it works with no server.
  2. Station mode in the Editor, via the Server relay: show devices and state, choose assignments. Needs a `shared/` change (section 7).
- **Hot-plug**: if the machine port vanishes mid-job, hold/reset is impossible, so mark the job failed with a clear reason, log it, and require operator confirmation after reconnect. If it vanishes while idle: go `disconnected`, keep scanning, reconnect on return. Same for the camera, which must never affect the laser.
- **Visibility**: every enumeration, probe, assignment and state change is logged; devices are included in `hello`, in status, and in the diagnostic bundle.

## 5. Camera enumeration risk
OpenCV indices are not stable and carry no names. We need DirectShow names on Windows. Candidate: a small pure-Python enumerator (for example `cv2-enumerate-cameras`) or direct DirectShow via the OpenCV backend. **First task in the device milestone is a throwaway probe built into the spike zip and run on one station PC** to confirm names and indices come back correctly, before depending on it.

## 6. Station state machine and safety
States: `starting` -> `disconnected` (no machine) -> `connecting` -> `needs_home` -> `idle` -> `framing` -> `running` <-> `paused` -> `idle`; plus `alarm` and `needs_attention`.
- `idle` requires homed and `Idle` reported. After any soft reset or alarm the state is `needs_home`; jobs and frame are refused until homed (homing is an operator action from Station mode; the Cutter exposes it as a control command).
- **Bounds check** before streaming and before frame: job bounds (from `run_job.bounds`, verified again by parsing the G-code) against the machine profile bed and `$130/$131`. Refuse with `ack accepted:false` and a reason.
- G-code safety scan: must start `G21`, `G90`; reject `G92`, `M3/M4` unless `$32=1`, coordinates outside the bed, `S` above `$30`. `gcodeSha256` must match the download.
- **Stop** = `!` then `0x18`, immediate, from any state. **Pause** = `!`, report `paused` only at `Hold:0`; **resume** = `~`.
- **Fault policy**: serial error, GRBL `ALARM`, `error:N` during a job, WebSocket loss while running, watchdog (no status for N seconds) -> feed hold then reset, job `failed` with a decoded reason, state `needs_home`. Camera failure does not stop the cut but is reported. WebSocket loss: hold + reset as the brief says; see open question 2 about a short grace period.
- All non-cutting moves (frame, jog) run at `S0`/`M5`. End of job and any stop: `M5`, then `M9` if air assist was on.
- No `G92` ever. Absolute coordinates. Units mm.
- **Restart behaviour**: after a Cutter or PC restart a job is never auto-resumed; the Server marks the job failed on reconnect and the state starts at `needs_home`.

## 7. Contract changes (`shared/`, one feature at a time)
The current contract does not carry devices or several things the real Cutter must report. Proposed **additive** change as one `shared/` bump (next version after `0.2.6`), done **first** so the Server and Editor can follow in parallel:
- `CutterHello`: add `unit`, `machineProfileId`, `devices` (ports and cameras with ids, state `ok`/`busy`/`missing`/`needs_attention`, assigned flag), `cutterBuildId`.
- New `CutterDevices` message (periodic and on change) and `ServerControl` commands `list_devices`, `assign_device`, `home`, `reset_alarm` (names to settle).
- `CutterStatus`: add `substate` (for `Hold:0`/`Hold:1`), `homed`, `alarm` (code and text), `cameraState`.
- `CutterJobResult`: add `reasonCode` (decoded fault list) alongside `message`.
- Station API and Editor: expose devices in `Station` and a device screen in Station mode (the Server and Editor sessions own their parts).
The Cutter work does not wait on this: M0 to M6 below only use the existing contract.

## 8. Logging (first-class)
JSON lines: `timestamp` (ms, UTC), `level`, `station`, `unit`, `job_id`, `event`, details. Categories as in the brief section 9: raw serial TX/RX at `DEBUG`, decoded GRBL state/alarms/errors, connection events, job lifecycle (line N of M, estimate vs actual), devices, camera events (never frames), network events, environment at start (OS, Python, Cutter version, build id, COM ports with USB ids, cameras).
- Local rotating files (10 x 10 MB), written even with no network; a ship queue sends them over the WebSocket when connected, with a persisted cursor so a restart neither resends nor loses.
- Levels remotely settable (`set_log_level`), default `INFO`; `DEBUG` expires on its own.
- Pupil IDs only in logs. No camera frames, no recordings.
- A top-level crash handler logs the traceback and then applies the fault policy; `faulthandler` file as in the spike.
- **Diagnostic bundle** (Station mode button, Server command, and `run_cutter.bat --diag`): zip of recent logs, `$$` dump, banner, config with the token removed, ports, cameras, network test, environment. Uploaded to `/stations/{id}/diagnostics/upload` and also saved next to the folder.

## 9. Camera (monitoring phase)
Capture thread at 5 to 10 fps, JPEG at a capped size and quality, sent as `camera` messages (base64, as the contract defines). Drop frames when the socket is slow; never queue. Camera failure never affects the laser; retry with backoff. Calibration and homography (brief section 10) are a **later phase**; keep a per-camera config slot only.

## 10. Network behaviour
Outbound WebSocket with the station token (from `cutter.json`, never logged), `hello` on connect (with `$$` and devices), `status` at about 2 Hz while a job runs and slower when idle, `progress` at about 1 Hz, reconnect with capped exponential backoff and jitter, ping/pong, stale-connection replacement is handled by the Server. G-code fetched over HTTPS with the token and checked against `gcodeSha256`. Server certificate verified (school proxy behaviour is open question 1).

## 11. Milestones (each ends with tests and a commit to `main`)
| # | Content | Done when |
|---|---|---|
| M0 | Scaffold `cutter/`, `pyproject`, `config.py`, `logs.py` (rotation, ship queue, levels), `fake_grbl` simulator | pytest green; logging tests cover rotation, redaction, restart cursor |
| M1 | `grbl/link.py` + `state.py` ported and hardened from the spike `Link`: reset-to-banner, send/ok, status parsing, `Hold:0` wait, alarm decoding | tests against `fake_grbl` incl. jog-ignores-hold, ALARM:3, timeouts, partial lines |
| M2 | Device manager (ports first), CLI `--devices`, assignment rules, hot-plug, busy detection | tests with a fake port list; manual check on one station PC |
| M3 | `jobrun.py`: bounds and G-code safety scan, streaming with progress, pause/resume/stop, fault policy, frame trace | job tests: stop mid-job, pause then resume, bounds refusal, serial drop mid-job |
| M4 | Network client against the **existing** `/ws/cutter` (match `fake_cutter`): hello, status, progress, ack, result, controls, download + sha, reconnect | integration test with the real Server app in-process and the simulated GRBL; Station mode drives it end to end |
| M5 | Camera enumeration (after the section 5 probe), capture and streaming, camera assignment in `--devices` | tests with a fake capture; frames visible in Station mode |
| M6 | Diagnostic bundle, remote log level, log shipping to the Server | bundle contents test; Server receives logs |
| M7 | Contract bump (section 7) as its own change, Cutter side implemented, Server and Editor follow in their sessions | Station mode device screen works against the Cutter |
| M8 | `build_cutter.py` portable zip, `run_cutter.bat`, config preserved across updates, self-check at start | zip built on Linux, runs on a station PC, passes `--diag` |
| M9 | On-station trial: S0 jog/frame, then a supervised low-power square, then a real cut; all four stations | checklist signed off per station |

The contract change should be *proposed* early (section 7) so other sessions can plan; implementing it does not block M0 to M6.

## 12. Open questions for the owner
1. School network: does a proxy or filter block outbound WebSocket/HTTPS from the station PCs? Spike test 10 never ran; run it with the Server URL set before M4 trials.
2. WebSocket loss mid-cut: hold and reset immediately (brief) or after a short grace period (proposal: 5 s) to ride out blips?
3. Homing: required at every Cutter start, or only after an alarm or reset? Proposal: after start, alarm and reset; otherwise trusted.
4. Falcon model names for the two machine types, so machine profiles can replace the placeholders.
5. Network-only cameras (A1 Pro class) are out of scope for these four stations; confirm.
6. Auto-start on login (Startup-folder shortcut, no installer) or started by hand each day?
7. Camera safeguarding sign-off before any frames leave the station PC.

## 13. Out of scope (for now)
Camera calibration and homography; character-counting streaming (send-and-wait is enough, optimise later); WebRTC video; Wi-Fi/HTTP control of newer Falcons; fire detection; automatic Cutter self-update.
