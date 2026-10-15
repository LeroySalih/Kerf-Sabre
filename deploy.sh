#!/usr/bin/env sh
# Deploy the Kerf Server on the VPS: back up the data, pull the latest main, then rebuild and restart behind the Cloudflare Tunnel.
# Run from anywhere:   ./deploy.sh        (KERF_SKIP_BACKUP=1 ./deploy.sh skips the backup; see backup.sh for where it goes and how to restore)
set -eu
cd "$(dirname "$0")"

# Back up first: a new version may upgrade the database on its first start. If the backup fails, nothing is changed.
if [ -z "${KERF_SKIP_BACKUP:-}" ]; then
  ./backup.sh
else
  echo "Skipping the backup (KERF_SKIP_BACKUP is set)."
fi

git pull

# The Windows Cutter that the Admin site offers for download (best effort: needs the internet; the first build downloads about 70 MB, later ones are quick).
# It is built inside a throwaway Python container, so the VPS needs no pip or venv of its own (Debian/Ubuntu's python3 often has neither).
# If it cannot be built, the Admin site offers the pretend Cutter instead and everything else works.
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/work -w /work python:3.12-slim python cutter/build_cutter.py \
  || echo "Could not build the Cutter download (offline?). The Admin site will offer the pretend Cutter."

cd server/deploy
docker compose -f docker-compose.cloudflare.yml up -d --build --remove-orphans
cd ../..

echo
echo "Deployed. Who holds a token (the tokens themselves are only ever shown once, when created):"
./kadmin list-tokens || echo "(the server is still starting: run ./kadmin list-tokens in a moment)"
cat <<'MSG'

Manage tokens with ./kadmin (it runs kerf-admin inside the server container):
  ./kadmin list-tokens
  ./kadmin create-token --role admin   --id <you>         # shown once, copy it now
  ./kadmin create-token --role teacher --id T001
  ./kadmin create-token --role station --id station-1
  ./kadmin revoke --id T001
  ./kadmin create-class --code 9B-DT
  ./kadmin add-pupils --class 9B-DT - < ids.csv > pins.csv   # one random PIN per new pupil, shown once; hand out, then delete pins.csv
  ./kadmin reset-pin --id P001
MSG
