#!/usr/bin/env bash
# Back up all persistent volumes and deploy/.env to deploy/backups/<timestamp>.tar.gz: ./backup.sh
# WARNING: the archive contains your Anytype account credentials, local data, the API key and the owner
# password. Store it encrypted. Restore with ./restore.sh (see docs/deploy.md).
set -euo pipefail
cd "$(dirname "$0")"

project=anytype-mcp
volumes=(anytype-data anytype-config connector-data caddy-data)
stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
chmod 700 backups

mounts=()
for v in "${volumes[@]}"; do mounts+=(-v "${project}_${v}:/src/${v}:ro"); done
mounts+=(-v "$PWD/.env:/src/config/.env:ro")

echo "==> Stopping anytype for a consistent snapshot"
docker compose stop anytype
trap 'docker compose start anytype >/dev/null' EXIT

docker run --rm "${mounts[@]}" -v "$PWD/backups:/backups" alpine \
  tar czf "/backups/${stamp}.tar.gz" -C /src "${volumes[@]}" config
chmod 600 "backups/${stamp}.tar.gz"
echo "Backup written to deploy/backups/${stamp}.tar.gz"
