#!/usr/bin/env sh
# Deploy the Kerf Server on the VPS: pull the latest main, then rebuild and restart behind the Cloudflare Tunnel.
# Run from anywhere:   ./deploy.sh
set -eu
cd "$(dirname "$0")"
git pull
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
