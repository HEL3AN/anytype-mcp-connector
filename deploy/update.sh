#!/usr/bin/env bash
# Update the stack: ./update.sh [--no-pull-repo]
# Pulls the repository and pinned images, rebuilds the connector, restarts, and checks readiness.
# If the new connector does not become ready, the previous connector image is restored.
set -euo pipefail
cd "$(dirname "$0")"

compose() { docker compose "$@"; }
env_value() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -E "s/^'(.*)'$/\1/; s/^\"(.*)\"$/\1/"; }
ready() {
  compose exec -T connector node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>r.text().then(t=>{console.log(t);process.exit(r.ok?0:1)}),()=>process.exit(1))" 2>/dev/null
}
wait_ready() {
  for _ in $(seq 1 30); do ready && return 0; sleep 2; done
  return 1
}

image=$(env_value CONNECTOR_IMAGE || true)
image=${image:-anytype-mcp-connector:local}

if [ "${1:-}" != "--no-pull-repo" ] && git -C .. rev-parse --git-dir >/dev/null 2>&1; then
  echo "==> Pulling repository"
  git -C .. pull --ff-only
fi

echo "==> Saving current connector image as rollback point"
docker image inspect "$image" >/dev/null 2>&1 && docker tag "$image" anytype-mcp-connector:previous || true

echo "==> Pulling images"
compose pull --ignore-buildable

echo "==> Rebuilding and restarting"
compose up -d --build --remove-orphans

echo "==> Checking readiness"
if wait_ready; then
  docker image prune -f >/dev/null
  echo "Update complete."
  exit 0
fi

echo "!! New version is not ready. Rolling back the connector."
compose logs --tail=50 connector || true
if docker image inspect anytype-mcp-connector:previous >/dev/null 2>&1; then
  docker tag anytype-mcp-connector:previous "$image"
  compose up -d --no-build connector
  wait_ready && echo "Rolled back to the previous connector image." && exit 1
fi
echo "Rollback failed or no previous image. Check: docker compose logs"
exit 1
