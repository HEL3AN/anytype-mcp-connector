# Deploying on a VPS

The stack runs three containers with Docker Compose:

| Service     | Image                              | Role                                                     |
|-------------|------------------------------------|----------------------------------------------------------|
| `anytype`   | `ghcr.io/anyproto/anytype-cli`     | Headless Anytype: syncs your spaces, serves the JSON API |
| `connector` | built from this repository         | MCP server + OAuth for Claude                            |
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
anytype's traffic transparently: anytype runs in the network namespace of a tun2socks container
(`egress`) that sends everything outside the Docker network through a SOCKS5 proxy. Enable it in
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

It pulls the repository and the pinned images, rebuilds the connector, restarts the stack and checks
`/readyz`. If the new connector fails to become ready, the previous image is restored.

To update headless Anytype or Caddy, change `ANYTYPE_CLI_IMAGE` / `CADDY_IMAGE` in `deploy/.env` and
run `./update.sh`. Pin exact versions: an Anytype API key created by a newer anytype-cli does not work
with an older one.

## Backups

```bash
./backup.sh
```

Writes `deploy/backups/<timestamp>.tar.gz` with all volumes (Anytype data and credentials, OAuth
state, certificates). The archive is sensitive: copy it off the server encrypted.

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
