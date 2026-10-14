#!/usr/bin/env python3
"""Start Kerf Sabre on this one PC: the Server, the Editor and a laser connector, on ports that don't clash.

    python3 start.py              # Windows: start.bat   Mac/Linux: ./start.sh
    python3 start.py --dev        # also run the Editor's live-reload dev server (a second port)
    python3 start.py --help

What runs
  Server     the API and (by default) the built Editor, on ONE port: http://localhost:8000 (the first free port from 8000).
  Editor     served by the Server. With --dev, Vite's hot-reload server runs too, on its own port (first free from 5173),
             and forwards /api to the Server, so there is nothing to configure.
  Connector  the laser connector for this PC. The real Cutter is not written yet (it waits for the spike results), so this
             runs the pretend Cutter, which behaves like a laser but cuts nothing. It only connects OUT to the Server, so it
             needs no port of its own. Use --connector none to leave it out.

Ports are checked before anything starts. If a preferred port is taken the next free one is used and the address is printed.
Everything stops together on Ctrl+C. Needs Python 3.11+ and Node (Node only to build the Editor).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "server"
EDITOR = ROOT / "editor"
WIN = os.name == "nt"
VENV_PY = SERVER / ".venv" / ("Scripts/python.exe" if WIN else "bin/python")


# ---------------------------------------------------------------- ports

def port_free(port: int) -> bool:
    """True if nothing is listening on, or holding, this port on any address (so a new listener can't clash)."""
    for host in ("127.0.0.1", "0.0.0.0"):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if not WIN:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, port))
        except OSError:
            return False
        finally:
            s.close()
    return True


def pick_port(preferred: int, taken: set[int], span: int = 100) -> int:
    """The first free port at or above `preferred` that is not already earmarked for something else."""
    for p in range(preferred, preferred + span):
        if p not in taken and port_free(p):
            return p
    raise SystemExit(f"No free port found between {preferred} and {preferred + span - 1}. Close something and try again.")


# ---------------------------------------------------------------- setup

def say(msg: str) -> None:
    print(f"[start] {msg}", flush=True)


def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None, quiet: bool = False) -> str:
    r = subprocess.run(cmd, cwd=cwd, env={**os.environ, **(env or {})}, capture_output=quiet, text=True, shell=WIN and cmd[0] in ("npm", "npx"))
    if r.returncode != 0:
        if quiet:
            print(r.stdout, r.stderr, file=sys.stderr)
        raise SystemExit(f"Command failed ({r.returncode}): {' '.join(cmd)}")
    return r.stdout if quiet else ""


def ensure_server_env(force: bool) -> None:
    if not VENV_PY.exists():
        say("Creating the Python environment (first time only)...")
        run([sys.executable, "-m", "venv", str(SERVER / ".venv")], SERVER)
        force = True
    ok = subprocess.run([str(VENV_PY), "-c", "import kerf_server, fastapi, websockets"], capture_output=True).returncode == 0
    if force or not ok:
        say("Installing the Server (a minute the first time)...")
        run([str(VENV_PY), "-m", "pip", "install", "-q", "-e", "."], SERVER)


def newest(path: Path) -> float:
    files = [p for p in path.rglob("*") if p.is_file() and "node_modules" not in p.parts and "dist" not in p.parts]
    return max((p.stat().st_mtime for p in files), default=0.0)


def ensure_editor_build(force: bool) -> None:
    dist = EDITOR / "dist" / "index.html"
    stale = not dist.exists() or newest(EDITOR) > dist.stat().st_mtime or newest(ROOT / "shared") > dist.stat().st_mtime
    if not (force or stale):
        return
    if not shutil.which("npm"):
        if dist.exists():
            say("npm not found, so the Editor is not rebuilt: using the existing build.")
            return
        raise SystemExit("The Editor needs building but Node/npm was not found. Install Node from https://nodejs.org and run again.")
    say("Building the Editor...")
    if not (EDITOR / "node_modules").exists():
        run(["npm", "install", "--no-audit", "--no-fund"], EDITOR)
    run(["npm", "run", "build"], EDITOR)


def admin(data_dir: Path, *args: str) -> str:
    env = {"KERF_DATA_DIR": str(data_dir)}
    r = subprocess.run([str(VENV_PY), "-m", "kerf_server.admin", *args], cwd=SERVER, env={**os.environ, **env}, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"kerf-admin {' '.join(args)} failed:\n{r.stdout}{r.stderr}")
    return r.stdout


def ensure_logins(data_dir: Path, station: str) -> dict:
    """Demo teacher, station and pupils, made once and remembered in data/local-logins.json."""
    f = data_dir / "local-logins.json"
    if f.exists():
        info = json.loads(f.read_text())
        if info.get("station") == station:
            return info
    say("Setting up demo logins (first time only)...")
    data_dir.mkdir(parents=True, exist_ok=True)
    admin(data_dir, "init-db")
    info: dict = {"station": station}
    info["teacher"] = admin(data_dir, "create-token", "--role", "teacher", "--id", "T001").strip().splitlines()[-1]
    info["stationToken"] = admin(data_dir, "create-token", "--role", "station", "--id", station).strip().splitlines()[-1]
    try:
        admin(data_dir, "create-class", "--code", "DEMO", "--label", "Demo class")
    except SystemExit:
        pass  # already there from an earlier run with a different station
    ids = data_dir / "demo-ids.csv"
    ids.write_text("P001\nP002\n")
    out = admin(data_dir, "add-pupils", "--class", "DEMO", str(ids))
    info["pupils"] = [dict(zip(("id", "pin"), line.split(","))) for line in out.strip().splitlines()[1:] if "," in line]
    f.write_text(json.dumps(info, indent=2))
    return info


# ---------------------------------------------------------------- processes

class Proc:
    """A child process whose output is shown with a [name] prefix."""

    def __init__(self, name: str, cmd: list[str], cwd: Path, env: dict[str, str]):
        self.name, self.cmd, self.cwd, self.env = name, cmd, cwd, env
        self.p: subprocess.Popen | None = None

    def start(self) -> None:
        self.p = subprocess.Popen(self.cmd, cwd=self.cwd, env={**os.environ, **self.env, "PYTHONUNBUFFERED": "1"}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  text=True, bufsize=1, shell=WIN and self.cmd[0] in ("npm", "npx"), **({"start_new_session": True} if not WIN else {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}))
        threading.Thread(target=self._pump, args=(self.p,), daemon=True).start()

    def _pump(self, p: subprocess.Popen) -> None:
        assert p.stdout
        for line in p.stdout:
            print(f"[{self.name}] {line.rstrip()}", flush=True)

    def alive(self) -> bool:
        return self.p is not None and self.p.poll() is None

    def stop(self) -> None:
        if not self.p or self.p.poll() is not None:
            return
        try:
            if WIN:
                self.p.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                os.killpg(self.p.pid, signal.SIGTERM)
            self.p.wait(timeout=8)
        except Exception:
            self.p.kill()


def wait_healthy(url: str, proc: Proc, timeout: float = 40.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        if not proc.alive():
            raise SystemExit("The Server stopped while starting. See its messages above.")
        try:
            with urllib.request.urlopen(url + "/health", timeout=1) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.3)
    raise SystemExit("The Server did not start in time. See its messages above.")


def lan_ip() -> str | None:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("192.0.2.1", 9))  # no packet is sent; this only asks which address would be used
        ip = s.getsockname()[0]
        s.close()
        return None if ip.startswith("127.") else ip
    except OSError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Run the Kerf Sabre Server, Editor and laser connector on this PC.")
    ap.add_argument("--port", type=int, default=8000, help="Server port to prefer (default 8000; the next free one is used if busy)")
    ap.add_argument("--dev", action="store_true", help="also run the Editor's live-reload dev server")
    ap.add_argument("--editor-port", type=int, default=5173, help="with --dev: Editor dev-server port to prefer (default 5173)")
    ap.add_argument("--connector", choices=("fake", "none"), default="fake", help="the laser connector: the pretend Cutter (default) or none")
    ap.add_argument("--station", default="station-1", help="which laser this PC is (a machine profile id; default station-1)")
    ap.add_argument("--speed", type=float, default=10.0, help="the pretend Cutter cuts this many times faster than the estimate")
    ap.add_argument("--lan", action="store_true", help="let other computers on the network reach the Server (default: this PC only)")
    ap.add_argument("--data-dir", default=str(SERVER / "data"), help="where the database, logs and logins are kept")
    ap.add_argument("--rebuild", action="store_true", help="rebuild the Editor and reinstall the Server")
    args = ap.parse_args()

    if sys.version_info < (3, 11):
        raise SystemExit(f"Python 3.11 or newer is needed (this is {sys.version.split()[0]}). Install it from https://www.python.org/downloads/ and run again.")
    data_dir = Path(args.data_dir).resolve()

    ensure_server_env(args.rebuild)
    ensure_editor_build(args.rebuild)

    earmarked: set[int] = set()
    server_port = pick_port(args.port, earmarked)
    earmarked.add(server_port)
    if server_port != args.port:
        say(f"Port {args.port} is busy, so the Server will use {server_port}.")
    editor_port = None
    if args.dev:
        if not (EDITOR / "node_modules").exists():
            run(["npm", "install", "--no-audit", "--no-fund"], EDITOR)
        editor_port = pick_port(args.editor_port, earmarked)
        earmarked.add(editor_port)
        if editor_port != args.editor_port:
            say(f"Port {args.editor_port} is busy, so the Editor dev server will use {editor_port}.")

    logins = ensure_logins(data_dir, args.station)
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    base = f"http://127.0.0.1:{server_port}"

    procs: list[Proc] = []
    server = Proc("server", [str(VENV_PY), "-m", "kerf_server.main"], SERVER, {
        "KERF_DATA_DIR": str(data_dir), "KERF_EDITOR_DIST": str(EDITOR / "dist"), "KERF_PORT": str(server_port), "KERF_HOST": host,
        "KERF_FORWARDED_ALLOW_IPS": "127.0.0.1", "KERF_LOG_LEVEL": "warning"})
    procs.append(server)
    stopping = False

    def shutdown(*_: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, shutdown)
    if not WIN:
        signal.signal(signal.SIGTERM, shutdown)

    try:
        server.start()
        wait_healthy(base, server)
        editor = None
        if args.dev:
            editor = Proc("editor", ["npx", "vite", "--port", str(editor_port), "--strictPort", "--host", host], EDITOR, {"KERF_SERVER_URL": base})
            procs.append(editor)
            editor.start()
        cutter = None
        if args.connector == "fake":
            cutter = Proc("cutter", [str(VENV_PY), "-m", "kerf_server.devtools.fake_cutter", "--url", base, "--token", logins["stationToken"], "--station", args.station,
                                     "--speed", str(args.speed)], SERVER, {})
            procs.append(cutter)
            cutter.start()

        ip = lan_ip() if args.lan else None
        open_url = f"http://localhost:{editor_port or server_port}"
        bar = "=" * 66
        print(f"\n{bar}\n Kerf Sabre is running\n")
        print(f"   Open:        {open_url}   <- the Editor" + ("  (live reload)" if args.dev else ""))
        print(f"   Server API:  http://localhost:{server_port}   (docs: /api/v1/docs)")
        if ip:
            print(f"   Other PCs:   http://{ip}:{editor_port or server_port}")
        print(f"   Connector:   " + (f"pretend laser '{args.station}' (cuts nothing; connects out to the Server)" if cutter else "none"))
        print(f"\n   Sign in as a pupil:  class DEMO, ID and PIN: " + ", ".join(f"{p['id']} / {p['pin']}" for p in logins["pupils"]))
        print(f"   Teacher token:       {logins['teacher']}   (click 'Teacher or laser station?')")
        print(f"   Station mode token:  {logins['stationToken']}")
        print(f"   Logins are saved in {data_dir / 'local-logins.json'}")
        print(f"\n   Press Ctrl+C to stop everything.\n{bar}\n", flush=True)

        restarts = 0
        while not stopping:
            time.sleep(0.5)
            if not server.alive():
                say("The Server stopped. Shutting down.")
                break
            if editor and not editor.alive():
                say("The Editor dev server stopped. Shutting down.")
                break
            if cutter and not cutter.alive():  # e.g. the Server restarted: reconnect
                restarts += 1
                say(f"The connector stopped; reconnecting in 3 s (attempt {restarts}).")
                time.sleep(3)
                if not stopping:
                    cutter.start()
    finally:
        say("Stopping...")
        for p in reversed(procs):
            p.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
