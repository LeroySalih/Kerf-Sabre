#!/usr/bin/env bash
# One command to run the whole Kerf Sabre server on this computer, with a demo teacher, class and pupil.
#   ./server/run-local.sh            (from the repository root; needs Python 3.11+ and Node)
# Opens at http://localhost:8000 (and http://<this computer's address>:8000 for other devices on the same network).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${KERF_PORT:-8000}"
PY="${PYTHON:-python3}"
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || { echo "Python 3.11 or newer is needed (found: $("$PY" --version))."; exit 1; }

if [ ! -d "$ROOT/editor/dist" ]; then
  echo "Building the Editor (first time only)..."
  (cd "$ROOT/editor" && npm install --no-audit --no-fund && npm run build)
fi
if [ ! -f "$ROOT/cutter/build/kerf-cutter.zip" ] && [ -z "${KERF_NO_CUTTER_BUILD:-}" ]; then   # the Windows Cutter that the Admin site offers (best effort; needs the internet once)
  echo "Building the Cutter download for the laser PCs (first time only; set KERF_NO_CUTTER_BUILD=1 to skip)..."
  "$PY" "$ROOT/cutter/build_cutter.py" || echo "Could not build it (offline?). The Admin site will offer the pretend Cutter instead."
fi
cd "$ROOT/server"
[ -d .venv ] || "$PY" -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q -e .

export KERF_DATA_DIR="${KERF_DATA_DIR:-$ROOT/server/data}" KERF_EDITOR_DIST="$ROOT/editor/dist" KERF_PORT="$PORT"
kerf-admin init-db >/dev/null
CREDS="$KERF_DATA_DIR/demo-logins.txt"
if [ ! -f "$CREDS" ]; then   # first run: make a demo teacher, a station, a class and a pupil
  {
    echo "Platform token: $(kerf-admin create-token --role platform --id owner | tail -1)   (creates schools; sees inside none)"
    echo "Admin token:    $(kerf-admin create-token --role admin --id A001 | tail -1)   (school 'main': all its classes, staff, lasers)"
    echo "Teacher token:  $(kerf-admin create-token --role teacher --id T001 | tail -1)"
    echo "Station token:  $(kerf-admin create-token --role station --id station-1 | tail -1)"
    kerf-admin create-class --code DEMO --label "Demo class" >/dev/null
    printf 'P001\nP002\n' > "$KERF_DATA_DIR/demo-ids.csv"
    echo "Pupil logins (class DEMO):"
    kerf-admin add-pupils --class DEMO "$KERF_DATA_DIR/demo-ids.csv" 2>/dev/null | tail -n +2 | sed 's/^/  /;s/,/  PIN /'
  } > "$CREDS"
fi
IP="$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)"
echo
echo "=================================================="
echo " Kerf Sabre server:  http://localhost:$PORT"
echo " Admin site:         http://localhost:$PORT/admin/   (teachers and school admins: classes, pupils, activities, queue, lasers)"
[ -n "$IP" ] && echo " From other devices: http://$IP:$PORT"
echo " Logins (saved in $CREDS):"
sed 's/^/   /' "$CREDS"
echo " Pupils sign in with class DEMO + ID + PIN; teachers and stations use 'sign in with a token'."
echo " Pretend laser:  python -m kerf_server.devtools.fake_cutter --token <station token>"
echo "=================================================="
exec kerf-server
