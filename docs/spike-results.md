# Spike results: all four station PCs (2026-10-14)

Raw logs: `spike/results/<station>/<run>/`. This is the summary the Cutter is built against. The production-Cutter gate in `CLAUDE.md` (spike results from all four stations) is met.

## Outcome
All four stations pass all nine runnable tests (list ports, banner, `$$`, `?`, `$H`, jog, M8/M9, feed hold/resume/soft reset, camera). Tests 10 (outbound HTTPS) and 11 (laser fire) were skipped, so **outbound HTTPS from the station PCs is still unverified** and no laser fire has been tested.

| Station | Host | OS | Port | Camera |
|---|---|---|---|---|
| 1 | AIO2-DTlab | Windows 10 (10.0.26200) | COM4 | index 0, frame OK |
| 2 | AIO-N-AFR-DTLab | same | COM9 | index 0, frame OK |
| 3 | AIO5-DTLeroy | same | COM5 | index 0, frame OK |
| 4 | AIO-DT-Leroy | same | COM5 | index 0, frame OK |

## Findings
1. **Controller is not a CH340.** All four enumerate as a native USB serial device (VID `303A`, PID `4001`, the ESP32-S3), banner `Grbl 1.1f ['$' for help]`. `docs/BRIEF.md` assumes CH340; do not match on VID/PID alone and do not require a CH340 driver.
2. **COM numbers differ per PC** (COM4, COM9, COM5, COM5) and can change after a restart or a different USB port. Each PC also has an Intel AMT "SOL" port (COM3) that is not GRBL.
3. **No banner on open.** The first read times out (2 s) on every station. Sending a soft reset (`0x18`) produces `[MSG:Using cpu_map...esp32-s3]` then the banner. The Cutter must do this on connect.
4. **Two machine types** (from `$$`):
   - Stations 3 and 4: bed 355 x 390 mm, Z axis 38 mm, accel `$120/$121=500`, extra settings (`$165`, `$170`-`$173`, `$190`), `$156=1`.
   - Stations 1 and 2: bed 400 x 415 mm, no Z settings, accel 1000, `$156=0`.
   - Common: `$30=1000`, `$32=1` (laser mode), `$22=1` (homing on), `$23=3`.
   Machine facts must come from per-station machine profiles, never hard-coded.
5. **Homing** (`$H`) works (about 0.8 s) and leaves MPos at 0.025,0.025. The machine origin is not exactly 0,0.
6. **Feed hold works on a normal `G1` move but not on a `$J` jog** (status stays `Jog`). The Cutter must not rely on holding a jog. `!` reports `Hold:1` (decelerating), then `Hold:0` (stopped). At F60 the head ran on about 0.4 mm. Wait for `Hold:0` before trusting the position. `~` resumes. Soft reset returns the banner and Idle (`ALARM:3` if reset mid-motion; `$X` or re-home; position may be lost).
7. **Air assist** M8/M9 works on all four (operator confirmed by eye; station 4 needed a re-run after one early "n").
8. **Camera** is a UVC device readable by OpenCV at index 0 on every PC (a separate USB camera, so the network-only camera case in the brief does not apply to these four). Frames are dark and fisheye-distorted; calibration will be needed.

## Requirement: manage connected COM ports (machines and cameras)
Port and camera numbers are not stable, so the Cutter and Station mode need explicit device management rather than a fixed `COM5` / index 0.

- **Enumerate** serial ports and cameras on demand and show them (name, COM port or camera index, VID/PID, hardware ID/location). Include "refresh".
- **Identify a machine port** by probing: open, soft reset, expect a `Grbl` banner. Skip ports that do not answer (AMT/SOL). Never hold a port open between probes; only one program may hold it.
- **Persist the choice** in the Cutter config file (plain file, preserved across updates). Prefer matching on stable identifiers (VID/PID plus serial or USB location) and fall back to re-probing when the saved COM number has changed. Allow the operator to override.
- **Cameras**: enumerate with names (OpenCV indices alone are not stable; use DirectShow device names or similar), let the operator pick which camera belongs to which machine, store the choice, and handle a camera that disappears or moves index.
- **Pairing**: one station may have more than one machine or camera in future, so model a station as machine(s) with an optional camera each, not a single hard-wired pair.
- **Visible state and logs**: report connected/missing/busy per device to the Server and Station mode, log every enumeration and selection (no camera frames), and give a clear message when a port is held by LightBurn/LaserGRBL/Creality software.
- **Hot-plug**: tolerate unplug/replug and a PC restart without losing the saved assignment.

## Open items
- Outbound HTTPS to the Server from a station PC (test 10).
- Laser fire at low power (test 11, optional).
- Confirm exact Falcon models for the two machine types and add their machine profiles.
- Update `docs/BRIEF.md` (CH340 assumption) once agreed.
