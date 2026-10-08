#!/usr/bin/env bash
# Restore the stack's volumes from a backup.sh archive: ./restore.sh backups/<timestamp>.tar.gz [--yes]
# Stops the stack, replaces the contents of every volume found in the archive, starts the stack and
# checks /readyz. Volumes that are not in the archive are left alone. deploy/.env is taken from the
# archive only if it does not exist yet (restoring onto a fresh checkout).
#
# Never run two copies of the same Anytype account data at once (e.g. the server and a restored test
# copy): they share one device identity. To check a backup elsewhere, keep that copy offline:
#   COMPOSE_FILE=docker-compose.yml:compose.offline.yml ./restore.sh <archive>
set -euo pipefail
cd "$(dirname "$0")"

compose() { docker compose "$@"; }

archive=${1:?usage: ./restore.sh <archive.tar.gz> [--yes]}
[ -f "$archive" ] || { echo "No such file: $archive"; exit 1; }
archive_dir=$(cd "$(dirname "$archive")" && pwd)
archive_name=$(basename "$archive")

if [ ! -f .env ]; then
  if tar tzf "$archive" config/.env >/dev/null 2>&1; then
    tar xzf "$archive" -O config/.env > .env
    chmod 600 .env
    echo "Restored deploy/.env from the archive."
  else
    echo "deploy/.env is missing and the archive has none: copy your .env here first."
    exit 1
  fi
fi

project=$(compose config --format json | sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' | head -1)
project=${project:-anytype-mcp}
known=" anytype-data anytype-config connector-data caddy-data "

mapfile -t volumes < <(tar tzf "$archive" | cut -d/ -f1 | sort -u | grep -vx config)
for v in "${volumes[@]}"; do
  [[ "$known" == *" $v "* ]] || { echo "Unexpected entry in the archive: $v"; exit 1; }
done
echo "Archive: $archive"
echo "Volumes to replace in project '$project': ${volumes[*]}"

if [ "${2:-}" != "--yes" ]; then
  read -rp "This overwrites the current data in these volumes. Continue? [y/N]: " answer
  [ "${answer,,}" = "y" ] || { echo "Aborted."; exit 1; }
fi

echo "==> Stopping the stack"
compose stop

for v in "${volumes[@]}"; do
  echo "==> Restoring $v"
  docker volume create \
    --label "com.docker.compose.project=$project" \
    --label "com.docker.compose.volume=$v" \
    "${project}_${v}" >/dev/null
  docker run --rm -v "${project}_${v}:/v" -v "$archive_dir:/b:ro" alpine sh -c \
    "find /v -mindepth 1 -delete && tar xzf '/b/$archive_name' -C /v --strip-components=1 '$v/'"
done

echo "==> Starting the stack"
compose up -d

echo "==> Checking readiness"
for _ in $(seq 1 60); do
  if compose exec -T connector node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>r.text().then(t=>{console.log(t);process.exit(r.ok?0:1)}),()=>process.exit(1))" 2>/dev/null; then
    echo "Restore complete."
    exit 0
  fi
  sleep 2
done
echo "The connector did not become ready. Check: docker compose logs connector anytype"
exit 1
