#!/usr/bin/env sh
# Back up the Kerf Server's data (database, station logs, diagnostic bundles) from the Docker volume to ./backups/kerf-data-<date>.tgz.
# Run from anywhere:   ./backup.sh        (./deploy.sh runs it first, and stops if it fails)
#   KERF_BACKUP_DIR=/some/folder   where the backups go (default ./backups next to this script)
#   KERF_BACKUP_KEEP=14            how many to keep (the newest; default 14)
#
# The database is copied with SQLite's own backup, taken inside the running container, so it is consistent even while people are using the
# server: it is the file backup/kerf-snapshot.db inside the .tgz. (A PostgreSQL database, KERF_DATABASE_URL, is not in the volume: back it up with pg_dump.)
#
# TO RESTORE (stop the server first):
#   docker compose -f server/deploy/docker-compose.cloudflare.yml down
#   docker run --rm -v <volume>:/data -v "$PWD/backups":/backup alpine sh -c 'cd /data && rm -rf ./* && tar xzf /backup/<file>.tgz && \
#       mv backup/kerf-snapshot.db kerf.db && rm -f kerf.db-wal kerf.db-shm'
#   ./deploy.sh        # (or: docker compose ... up -d)
# <volume> is printed by this script ("data volume: ...").
set -eu
cd "$(dirname "$0")"
COMPOSE="docker compose -f server/deploy/docker-compose.cloudflare.yml"
BACKUPS="${KERF_BACKUP_DIR:-$PWD/backups}"
KEEP="${KERF_BACKUP_KEEP:-14}"
mkdir -p "$BACKUPS"

# the data volume: the one mounted in the running server, else any volume called ...kerf-data
CID="$($COMPOSE ps -q kerf 2>/dev/null || true)"
VOL=""
if [ -n "$CID" ]; then
  VOL="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$CID" 2>/dev/null || true)"
fi
if [ -z "$VOL" ]; then
  VOL="$(docker volume ls -q 2>/dev/null | grep -E '(^|_)kerf-data$' | head -n 1 || true)"
fi
if [ -z "$VOL" ]; then
  echo "Backup: no Kerf data volume found, so there is nothing to back up yet (is this the first deploy?)."
  exit 0
fi
echo "Backup: data volume: $VOL"

# a consistent copy of the SQLite database, made by the running server
if [ -n "$CID" ]; then
  $COMPOSE exec -T kerf python - <<'PY' || { echo "Backup FAILED: could not snapshot the database inside the running server." >&2; exit 1; }
import os, sqlite3
from kerf_server.config import Settings
s = Settings.from_env()
if not s.db_url.startswith("sqlite"):
    print("Backup: the database is not SQLite, so it is not in this backup (use pg_dump).")
else:
    src_path = s.db_url.replace("sqlite:///", "", 1)
    folder = os.path.join(str(s.data_dir), "backup")
    os.makedirs(folder, exist_ok=True)
    src, out = sqlite3.connect(src_path), sqlite3.connect(os.path.join(folder, "kerf-snapshot.db"))
    src.backup(out)
    out.close()
    src.close()
    print("Backup: database snapshot taken")
PY
fi

FILE="kerf-data-$(date +%Y%m%d-%H%M%S).tgz"
docker run --rm -v "$VOL":/data:ro -v "$BACKUPS":/backup alpine sh -c "tar czf /backup/$FILE -C /data ." \
  || { echo "Backup FAILED: could not write $BACKUPS/$FILE" >&2; rm -f "$BACKUPS/$FILE"; exit 1; }
if [ ! -s "$BACKUPS/$FILE" ] || ! tar tzf "$BACKUPS/$FILE" >/dev/null 2>&1; then
  echo "Backup FAILED: $BACKUPS/$FILE is empty or damaged." >&2
  exit 1
fi
echo "Backup: wrote $BACKUPS/$FILE ($(du -h "$BACKUPS/$FILE" | cut -f1))"

# keep the newest $KEEP
ls -1t "$BACKUPS"/kerf-data-*.tgz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f "$old" && echo "Backup: removed old $old"; done
exit 0
