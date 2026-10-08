#!/usr/bin/env bash
# Update the stack: ./update.sh [--no-pull-repo]
# Pulls the repository and the pinned images, then either pulls the released connector image
# (CONNECTOR_IMAGE=ghcr.io/...:<tag> in .env) or rebuilds it from this checkout (default), restarts,
# and checks readiness. If the new connector does not become ready, the previous image is restored.
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
running_version() {
  compose exec -T connector node -p "require('./package.json').version" 2>/dev/null || echo "?"
}

image=$(env_value CONNECTOR_IMAGE || true)
image=${image:-anytype-mcp-connector:local}
# A registry reference (contains "/") means: use released images instead of building locally.
released=false
[[ "$image" == */* ]] && released=true

if [ "${1:-}" != "--no-pull-repo" ] && git -C .. rev-parse --git-dir >/dev/null 2>&1; then
  echo "==> Pulling repository"
  git -C .. pull --ff-only
fi

before=$(running_version)

echo "==> Saving current connector image as rollback point"
if docker image inspect "$image" >/dev/null 2>&1; then
  docker tag "$image" anytype-mcp-connector:previous
fi

echo "==> Pulling images"
compose pull --ignore-buildable
if $released; then
  docker pull "$image"
  echo "==> Restarting"
  compose up -d --no-build --remove-orphans
else
  echo "==> Rebuilding and restarting"
  compose up -d --build --remove-orphans
fi

echo "==> Checking readiness"
if wait_ready; then
  docker image prune -f >/dev/null
  echo "Update complete: connector $before -> $(running_version)."
  exit 0
fi

echo "!! New version is not ready. Rolling back the connector."
compose logs --tail=50 connector || true
if docker image inspect anytype-mcp-connector:previous >/dev/null 2>&1; then
  docker tag anytype-mcp-connector:previous "$image"
  compose up -d --no-build connector
  if wait_ready; then
    echo "Rolled back to the previous connector image ($before)."
    exit 1
  fi
fi
echo "Rollback failed or no previous image. Check: docker compose logs"
exit 1
