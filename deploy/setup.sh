#!/usr/bin/env bash
# First-time setup on the server. Run from the deploy/ directory: ./setup.sh
# - starts headless Anytype, logs it into your account (account key) or creates a bot account
# - creates a scoped API key for the connector and stores it in .env
# - builds and starts the whole stack, then checks readiness
set -euo pipefail
cd "$(dirname "$0")"

compose() { docker compose "$@"; }
any() { compose exec -T anytype anytype "$@"; }
strip_ansi() { sed -E 's/\x1b\[[0-9;]*m//g'; }
# set_env KEY VALUE — replace or append in .env. Single quotes make Compose read the value literally
# (no $-interpolation), so values must not contain a single quote.
set_env() {
  case "$2" in *"'"*) echo "Values must not contain a single quote ('): $1"; exit 1 ;; esac
  NEWLINE="$1='$2'" awk -v k="$1" '
    BEGIN { line = ENVIRON["NEWLINE"] }
    index($0, k "=") == 1 { print line; done = 1; next }
    { print }
    END { if (!done) print line }
  ' .env > .env.tmp && mv .env.tmp .env && chmod 600 .env
}
env_value() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -E "s/^'(.*)'$/\1/; s/^\"(.*)\"$/\1/"; }

command -v docker >/dev/null || { echo "Docker is not installed: https://docs.docker.com/engine/install/"; exit 1; }

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "Created deploy/.env from the template."
fi

domain=$(env_value DOMAIN)
if [ -z "$domain" ] || [ "$domain" = "anytype.example.com" ]; then
  read -rp "Public domain for the connector (e.g. anytype.example.com): " domain
  set_env DOMAIN "$domain"
fi

if [ "$(env_value COMPOSE_PROFILES)" = "caddy" ] && ss -ltnH 2>/dev/null | grep -qE '[:.](80|443)\s'; then
  echo "Ports 80/443 are already in use on this host (an existing reverse proxy?)."
  read -rp "Use that proxy instead of the bundled Caddy? [Y/n]: " use_host_proxy
  if [ "${use_host_proxy,,}" != "n" ]; then set_env COMPOSE_PROFILES ""; fi
fi

password=$(env_value OWNER_PASSWORD)
if [ ${#password} -lt 12 ]; then
  while :; do
    read -rsp "Owner password for the consent page (min 12 chars): " password; echo
    [ ${#password} -ge 12 ] && break
    echo "Too short."
  done
  set_env OWNER_PASSWORD "$password"
fi

echo "==> Starting headless Anytype"
compose up -d anytype
for _ in $(seq 1 60); do
  any auth status >/dev/null 2>&1 && break
  sleep 2
done

if any auth status 2>/dev/null | strip_ansi | grep -q "Logged in"; then
  echo "Anytype is already logged in."
else
  echo
  echo "How should headless Anytype sign in?"
  echo "  1) My account, with an account key (from tools/derive-account-key)"
  echo "  2) New bot account (invite it to the spaces you want Claude to see)"
  read -rp "Choice [1/2]: " choice
  if [ "$choice" = "2" ]; then
    read -rp "Bot account name: " bot_name
    any auth create "$bot_name" | strip_ansi
    echo "Save the account key printed above somewhere safe."
  else
    read -rsp "Account key (input hidden): " account_key; echo
    printf '%s\n' "$account_key" | any auth login | strip_ansi
    unset account_key
  fi
fi

echo
echo "==> Spaces visible to this account (sync can take a few minutes after the first login)"
any space list | strip_ansi || true

if [ -z "$(env_value ANYTYPE_API_KEY)" ]; then
  echo
  echo "Which spaces should Claude access?"
  echo "  - press Enter for all spaces (read-write)"
  echo "  - or type space names/ids separated by commas"
  read -rp "Spaces: " spaces
  args=(auth apikey create claude-connector --read-write)
  if [ -z "$spaces" ]; then
    args+=(--all-spaces)
  else
    IFS=',' read -ra list <<< "$spaces"
    for s in "${list[@]}"; do args+=(--space "$(echo "$s" | xargs)"); done
  fi
  out=$(any "${args[@]}" | strip_ansi)
  key=$(printf '%s\n' "$out" | sed -n 's/.*Key: *//p' | head -1)
  [ -n "$key" ] || { printf '%s\n' "$out"; echo "Could not read the API key from the output above."; exit 1; }
  set_env ANYTYPE_API_KEY "$key"
  printf '%s\n' "$out" | grep -v "Key:" || true
  echo "API key stored in deploy/.env"
fi

echo
echo "==> Building and starting the stack"
compose up -d --build

echo "==> Waiting for the connector to become ready"
for _ in $(seq 1 30); do
  if compose exec -T connector node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>r.text().then(t=>{console.log(t);process.exit(r.ok?0:1)}),()=>process.exit(1))" 2>/dev/null; then
    domain=$(env_value DOMAIN)
    echo
    if [ -z "$(env_value COMPOSE_PROFILES)" ]; then
      port=$(env_value CONNECTOR_PORT); port=${port:-3040}
      sed "s/anytype\.example\.com/$domain/g; s/127\.0\.0\.1:3040/127.0.0.1:$port/" nginx/anytype-mcp.conf.example \
        > "nginx/$domain.conf"
      echo "Connector is listening on 127.0.0.1:$port. Enable the nginx site (needs sudo):"
      echo "  sudo cp $PWD/nginx/$domain.conf /etc/nginx/sites-available/$domain"
      echo "  sudo ln -s /etc/nginx/sites-available/$domain /etc/nginx/sites-enabled/"
      echo "  sudo nginx -t && sudo systemctl reload nginx"
      echo "  sudo certbot --nginx -d $domain"
      echo
    fi
    echo "Then add this URL in Claude (Settings > Connectors > Add custom connector):"
    echo "  https://$domain/mcp"
    exit 0
  fi
  sleep 2
done
echo "The connector did not become ready. Check: docker compose logs connector anytype"
exit 1
