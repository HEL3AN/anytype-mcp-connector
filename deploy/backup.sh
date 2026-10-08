#!/usr/bin/env bash
# Back up all persistent volumes and deploy/.env to deploy/backups/<timestamp>.tar.gz: ./backup.sh
# Keeps the newest BACKUP_KEEP archives (default 14, 0 = keep all). Safe to run from cron.
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

# The container runs as root (it must read the volumes): create the archive private (umask 077) and
# hand it to the invoking user.
docker run --rm "${mounts[@]}" -v "$PWD/backups:/backups" -e OWNER="$(id -u):$(id -g)" alpine sh -c \
  'umask 077 && tar czf "/backups/$0.tar.gz" -C /src "$@" config && chown "$OWNER" "/backups/$0.tar.gz"' \
  "$stamp" "${volumes[@]}"
echo "Backup written to deploy/backups/${stamp}.tar.gz"

keep=${BACKUP_KEEP:-14}
if [ "$keep" -gt 0 ]; then
  find backups -maxdepth 1 -name '*.tar.gz' -printf '%f
' | sort -r | tail -n +"$((keep + 1))" |
    while read -r old; do rm -f "backups/$old" && echo "Removed old backup $old"; done
fi
