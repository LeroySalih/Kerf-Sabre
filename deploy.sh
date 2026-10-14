#!/usr/bin/env sh
# Deploy the Kerf Server on the VPS: pull the latest main, then rebuild and restart behind the Cloudflare Tunnel.
# Run from anywhere:   ./deploy.sh
set -eu
cd "$(dirname "$0")"
git pull
cd server/deploy
docker compose -f docker-compose.cloudflare.yml up -d --build --remove-orphans
