"""Admin command line: `kerf-admin ...` (or `python -m kerf_server.admin ...`).

Pupils and teachers are identified by ID only. Tokens are shown once, when created, and only their hash is stored.
"""
from __future__ import annotations

import argparse
import csv
import sys

from sqlalchemy import select

from .config import Settings
from .db import Database
from .models import Token
from .security import ROLES, hash_token, issue_token
from .services_seed import seed


def _db() -> tuple[Database, Settings]:
    s = Settings.from_env()
    s.data_dir.mkdir(parents=True, exist_ok=True)
    db = Database(s.db_url)
    db.create_all()
    seed(db, s)
    return db, s


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="kerf-admin", description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init-db", help="create the tables and load the placeholder presets and machines")
    t = sub.add_parser("create-token", help="issue a token for a pupil, teacher or station")
    t.add_argument("--role", choices=ROLES, required=True)
    t.add_argument("--id", required=True, help="pupil ID, teacher ID or station id (e.g. station-1). Never a name.")
    t.add_argument("--label", help="a note for you, e.g. 'Y9 set 2' (not a name)")
    ip = sub.add_parser("import-pupils", help="issue a token for every pupil ID in a CSV (column 'pupilId' or one ID per line)")
    ip.add_argument("csv")
    ip.add_argument("--out", help="write pupilId,token to this file instead of the screen")
    sub.add_parser("list-tokens", help="list who holds a token (never shows the tokens)")
    r = sub.add_parser("revoke", help="revoke every token held by an ID")
    r.add_argument("--id", required=True)
    args = ap.parse_args(argv)

    db, _ = _db()
    if args.cmd == "init-db":
        print("Database ready.")
    elif args.cmd == "create-token":
        print(issue_token(db, args.role, args.id, args.label))
    elif args.cmd == "import-pupils":
        with open(args.csv, newline="") as f:
            rows = [r for r in csv.reader(f) if r]
        if rows and rows[0] and rows[0][0].strip().lower() in ("pupilid", "pupil_id", "id"):
            rows = rows[1:]
        out = open(args.out, "w", newline="") if args.out else sys.stdout
        w = csv.writer(out)
        w.writerow(["pupilId", "token"])
        for row in rows:
            w.writerow([row[0].strip(), issue_token(db, "pupil", row[0].strip())])
        if args.out:
            out.close()
            print(f"Wrote {len(rows)} tokens to {args.out}. Hand them out, then delete the file.")
    elif args.cmd == "list-tokens":
        with db.session() as s:
            for tok in s.scalars(select(Token).order_by(Token.role, Token.subject_id)):
                print(f"{tok.role:8} {tok.subject_id:24} {'REVOKED' if tok.revoked else 'active':8} {tok.label or ''}")
    elif args.cmd == "revoke":
        with db.session() as s:
            n = 0
            for tok in s.scalars(select(Token).where(Token.subject_id == args.id, Token.revoked.is_(False))):
                tok.revoked = True
                n += 1
        print(f"Revoked {n} token(s) for {args.id}.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
