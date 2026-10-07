#!/usr/bin/env bash
# Back up all persistent volumes to deploy/backups/<timestamp>.tar.gz: ./backup.sh
# WARNING: the archive contains your Anytype account credentials and local data. Store it encrypted.
# Restore: stop the stack, then for each volume
#   docker run --rm -v anytype-mcp_<vol>:/v -v "$PWD/backups":/b alpine sh -c 'cd /v && tar xzf /b/<file> <vol>/ --strip-components=1'
set -euo pipefail
cd "$(dirname "$0")"

project=anytype-mcp
volumes=(anytype-data anytype-config connector-data caddy-data)
stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
chmod 700 backups

mounts=()
for v in "${volumes[@]}"; do mounts+=(-v "${project}_${v}:/src/${v}:ro"); done

echo "==> Stopping anytype for a consistent snapshot"
docker compose stop anytype
trap 'docker compose start anytype >/dev/null' EXIT

docker run --rm "${mounts[@]}" -v "$PWD/backups:/backups" alpine \
  tar czf "/backups/${stamp}.tar.gz" -C /src "${volumes[@]}"
chmod 600 "backups/${stamp}.tar.gz"
echo "Backup written to deploy/backups/${stamp}.tar.gz"
