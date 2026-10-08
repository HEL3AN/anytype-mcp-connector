# Deploying on a VPS

The stack runs three containers with Docker Compose:

| Service     | Image                              | Role                                                     |
|-------------|------------------------------------|----------------------------------------------------------|
| `anytype`   | `ghcr.io/anyproto/anytype-cli`     | Headless Anytype: syncs your spaces, serves the JSON API |
| `connector` | built from this repository, or `ghcr.io/hel3an/anytype-mcp-connector` | MCP server + OAuth for Claude |
| `caddy`     | `caddy`                            | HTTPS with automatic Let's Encrypt certificates          |

The Anytype API is reachable only from the connector. The connector is published on
`127.0.0.1:3040` for a reverse proxy on the host.

**Reverse proxy.** If the server has nothing on ports 80/443, the bundled Caddy (`COMPOSE_PROFILES=caddy`,
the default) handles HTTPS automatically. If you already run nginx or another proxy, `setup.sh`
detects the busy ports, disables Caddy and generates an nginx site in `deploy/nginx/<domain>.conf`
(SSE-friendly: no buffering, long read timeout); enable it and run `certbot --nginx -d <domain>`.

## Requirements

- Linux VPS (amd64 or arm64), 1 vCPU, **1 GB RAM minimum** (2 GB recommended for large spaces)
- Docker Engine with the Compose plugin
- A domain name with an `A` (and optionally `AAAA`) record pointing to the VPS
- Ports 80 and 443 open

If the domain is on Cloudflare, start with the record set to **DNS only** (grey cloud) so Caddy can
obtain its certificate. Proxying through Cloudflare can be enabled later with SSL mode "Full (strict)".

## Choose how headless Anytype signs in

- **Your own account** — Claude sees all your spaces. You need the *account key* derived from your
  12-word login key: run `tools/derive-account-key` **on your own computer, offline**, and paste only
  its output into the setup script. The account key gives full access to your account and cannot be
  revoked; the server stores it in the `anytype-config` volume, so treat the VPS (and its backups)
  accordingly.
- **A bot account** — isolated: it sees only the spaces you invite it to and can be removed from them
  at any time. Recommended if other people use the server.

## First deployment

```bash
git clone <this repository> anytype-mcp && cd anytype-mcp/deploy
./setup.sh
```

The script asks for the domain, an owner password (typed on the consent page when you connect
Claude), signs Anytype in, creates a scoped API key and starts everything. When it prints the
connector URL, add it in Claude: **Settings → Connectors → Add custom connector** →
`https://<domain>/mcp`, then approve on the consent page with the owner password.

After the first login Anytype needs a few minutes to sync your spaces.

## When the Anytype sync network is blocked

Symptoms: Anytype logs in, but `docker compose exec anytype anytype space list` stays empty and the
logs repeat `can't sync with peer` / `no recent network activity`. TCP connects, but traffic to the
sync nodes is filtered (common with DPI-based blocking).

The anytype-heart networking code has no proxy support, so `deploy/compose.proxy.yml` routes
traffic transparently: anytype **and the connector** run in the network namespace of a tun2socks
container (`egress`) that sends everything outside the Docker network through a SOCKS5 proxy. The
connector needs it too: it fetches Claude's OAuth client metadata from `claude.ai`, which redirects
requests from some regions (e.g. Russia) to an "unavailable" page. Enable it in
`deploy/.env`:

```bash
COMPOSE_FILE=docker-compose.yml:compose.proxy.yml
EGRESS_PROXY=socks5://<host>:<port>     # a SOCKS5 proxy reachable from containers
```

If the proxy only listens on the host's loopback (for example a local xray/VLESS client on
`127.0.0.1:10808`), use the bundled bridge instead of `EGRESS_PROXY`:

```bash
COMPOSE_FILE=docker-compose.yml:compose.proxy.yml
COMPOSE_PROFILES=host-proxy              # comma-separate if you also use caddy
HOST_PROXY_PORT=10808
```

The bridge listens on the backend network's gateway (`172.31.250.1:10818`), which is not reachable
from outside. A host firewall must allow containers to reach it; with ufw:

```bash
sudo ufw allow in on br-anytype-mcp to 172.31.250.1 port 10818 proto tcp comment 'anytype-mcp egress'
```

Apply with `docker compose down && docker compose up -d` (volumes are kept), then check the exit IP:
`docker compose exec anytype wget -qO- https://ifconfig.me/ip`.

`ANYTYPE_PREFER_TCP=true` (the default) makes Anytype sync over TCP instead of QUIC/UDP, which works
through SOCKS and on hosts with small UDP buffers.

## Updating

```bash
cd anytype-mcp/deploy
./update.sh
```

It pulls the repository and the pinned images, updates the connector, restarts the stack and checks
`/readyz`. If the new connector fails to become ready, the previous image is restored.

**Released images (recommended).** Every release publishes a multi-arch image (linux/amd64, linux/arm64)
to GHCR, so the server does not need to build anything. In `deploy/.env`:

```bash
CONNECTOR_IMAGE=ghcr.io/hel3an/anytype-mcp-connector:latest   # newest release
# CONNECTOR_IMAGE=ghcr.io/hel3an/anytype-mcp-connector:0.2      # newest 0.2.x
# CONNECTOR_IMAGE=ghcr.io/hel3an/anytype-mcp-connector:0.2.0    # exactly this version
```

`update.sh` then pulls that tag instead of building. To go back to a known-good version after a bad
release, pin its exact tag and run `./update.sh` again. Leave `CONNECTOR_IMAGE` empty to build from
your checkout (for local changes or forks).

While the GHCR package is private, log the server in once with a token that has `read:packages`:
`docker login ghcr.io -u <github-user>` (paste the token as the password).

To update headless Anytype or Caddy, change `ANYTYPE_CLI_IMAGE` / `CADDY_IMAGE` in `deploy/.env` and
run `./update.sh`. Pin exact versions: an Anytype API key created by a newer anytype-cli does not work
with an older one.

## Backups

```bash
./backup.sh
```

Stops Anytype for a few seconds and writes `deploy/backups/<timestamp>.tar.gz` (mode 600) with all
volumes — Anytype data and credentials, OAuth state, certificates — and `deploy/.env`. The newest 14
archives are kept (`BACKUP_KEEP=<n>`, `0` keeps all). The archive gives full access to your Anytype
account: copy it off the server encrypted, e.g. `age -p` or `gpg -c`.

Nightly backups with cron (`crontab -e`, as the user that runs Docker):

```cron
30 4 * * * cd /path/to/anytype-mcp/deploy && ./backup.sh >> backups/backup.log 2>&1
```

### Restoring

```bash
./restore.sh backups/<timestamp>.tar.gz
```

Stops the stack, replaces the contents of every volume in the archive, starts the stack again and
checks `/readyz`. On a new server, clone the repository, put the archive into `deploy/backups/` and
run the same command: `deploy/.env` is taken from the archive when it does not exist yet. Existing
Claude connections keep working, because the OAuth signing key and refresh tokens are restored too.

**Checking a backup on another machine.** The restored copy is the same Anytype *device* as the
server; never let both sync at the same time. Restore it with the network cut off:

```bash
COMPOSE_FILE=docker-compose.yml:compose.offline.yml COMPOSE_PROFILES= ./restore.sh backups/<timestamp>.tar.gz
docker compose exec anytype anytype space list
COMPOSE_FILE=docker-compose.yml:compose.offline.yml COMPOSE_PROFILES=caddy docker compose down -v   # remove the copy
```

Anytype logs `unable to connect` in this mode; that is expected. Pre-pull the images
(`docker pull ...`) before running it on a machine that has never run the stack.

## Operations

```bash
docker compose ps                      # status and health
docker compose logs -f connector       # one line per request, tool names, no content
docker compose exec anytype anytype space list
docker compose exec anytype anytype auth apikey list
```

- `GET /healthz` — the connector process is up (returns its version)
- `GET /readyz` — Anytype is reachable and the API key works

### Changing the owner password

Edit `OWNER_PASSWORD` in `deploy/.env` and run `docker compose up -d connector`. Existing Claude
connections keep working; the new password is needed for the next connection.

### Disconnecting all Claude sessions

```bash
docker compose stop connector
docker compose run --rm --entrypoint sh connector -c 'rm -f /data/oauth.json /data/signing.key'
docker compose up -d connector
```

Every client then has to connect again.
