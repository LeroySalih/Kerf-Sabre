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
from . import services_classes as sc
from .security import ROLES, hash_token, issue_token
from . import services_schools as ss
from .models import DEFAULT_SCHOOL
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
    cs = sub.add_parser("create-school", help="create a school (with an optional first admin, whose token is printed once)")
    cs.add_argument("--id", required=True, help="lower-case letters, digits and -, e.g. bisak")
    cs.add_argument("--name", required=True)
    cs.add_argument("--admin", help="ID of the school's first admin")
    sub.add_parser("list-schools", help="list the schools")
    t = sub.add_parser("create-token", help="issue a token for a pupil, teacher, school admin, station or the platform owner")
    t.add_argument("--role", choices=ROLES, required=True)
    t.add_argument("--id", required=True, help="pupil ID, teacher ID or station id (e.g. station-1). Never a name.")
    t.add_argument("--label", help="a note for you, e.g. 'Y9 set 2' (not a name)")
    t.add_argument("--school", default=DEFAULT_SCHOOL, help=f"the school it belongs to (default {DEFAULT_SCHOOL}; ignored for the platform role)")
    ip = sub.add_parser("import-pupils", help="issue a token for every pupil ID in a CSV (column 'pupilId' or one ID per line)")
    ip.add_argument("csv")
    ip.add_argument("--out", help="write pupilId,token to this file instead of the screen")
    cc = sub.add_parser("create-class", help="create a class that pupils log in through")
    cc.add_argument("--code", required=True, help="e.g. 9B-DT")
    cc.add_argument("--label", help="a note for teachers, e.g. 'Y9 set 2' (not a name)")
    cc.add_argument("--school", default=DEFAULT_SCHOOL)
    ap_ = sub.add_parser("add-pupils", help="add pupil IDs to a class and print a PIN for each new one")
    ap_.add_argument("--class", dest="class_code", required=True)
    ap_.add_argument("file", help="CSV with a 'pupilId' column, or one ID per line")
    ap_.add_argument("--out", help="write pupilId,pin to this file instead of the screen")
    rp = sub.add_parser("reset-pin", help="new PIN for a pupil (clears a lockout and ends their sessions)")
    rp.add_argument("--id", required=True)
    sub.add_parser("list-tokens", help="list who holds a token (never shows the tokens)")
    r = sub.add_parser("revoke", help="revoke every token held by an ID")
    r.add_argument("--id", required=True)
    args = ap.parse_args(argv)

    db, _ = _db()
    if args.cmd == "init-db":
        print("Database ready.")
    elif args.cmd == "create-school":
        with db.session() as s_:
            school = ss.create_school(s_, args.id, args.name)
        print(f"Created school {school.id}.", file=sys.stderr)
        if args.admin:
            print(ss.add_staff(db, school.id, "admin", args.admin, "first admin"))
    elif args.cmd == "list-schools":
        with db.session() as s_:
            for row in ss.list_schools(s_):
                print(f"{row['id']:20} {row['name']}")
    elif args.cmd == "create-token":
        print(issue_token(db, args.role, args.id, args.label, args.school))
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
    elif args.cmd == "create-class":
        with db.session() as s_:
            c = sc.create_class(s_, args.code, args.label, school=args.school)
            print(f"Created class {c.code}.")
    elif args.cmd == "add-pupils":
        with open(args.file, newline="") as f:
            rows = [r for r in csv.reader(f) if r]
        if rows and rows[0] and rows[0][0].strip().lower() in ("pupilid", "pupil_id", "id"):
            rows = rows[1:]
        with db.session() as s_:
            res = sc.add_pupils(s_, args.class_code, [r[0] for r in rows])
        out = open(args.out, "w", newline="") if args.out else sys.stdout
        w = csv.writer(out)
        w.writerow(["pupilId", "pin"])
        for c in res["created"]:
            w.writerow([c["pupilId"], c["pin"]])
        if args.out:
            out.close()
        print(f"{len(res['created'])} added, {len(res['existing'])} already in the class, {len(res['conflicts'])} belong to another class{' ' + str(res['conflicts']) if res['conflicts'] else ''}."
              + (f" PINs written to {args.out}: hand them out, then delete the file." if args.out else ""), file=sys.stderr)
    elif args.cmd == "reset-pin":
        with db.session() as s_:
            print(sc.reset_pin(s_, args.id))
    elif args.cmd == "list-tokens":
        with db.session() as s:
            for tok in s.scalars(select(Token).order_by(Token.role, Token.subject_id)):
                print(f"{tok.role:8} {tok.school_id or '-':12} {tok.subject_id:24} {'REVOKED' if tok.revoked else 'active':8} {tok.label or ''}")
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
