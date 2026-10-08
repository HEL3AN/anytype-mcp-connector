# CLAUDE.md — Anytype MCP connector

Read this first. It is the hand-off document between sessions and machines: what the project is,
how it is deployed, how to test, and the non-obvious things we learned the hard way.
Open work is tracked in **GitHub Issues** (`gh issue list`) and summarized in `ROADMAP.md`.

## What this is

A self-hosted **remote MCP server** that lets Claude (claude.ai web/desktop/mobile, Claude Code)
search, read and edit an **Anytype** workspace. Anytype is local-first and has no cloud API, so the
connector talks to a headless Anytype (`anytype-cli`) running next to it. Goal: a polished open-source
connector, eventually listed in the Claude connectors directory.

- Production: `https://anytype.example.com/mcp` (live since 2026-10-07, used daily by the owner).
- Repo: `github.com/HEL3AN/anytype-mcp-connector` (private for now, branch `main`).
- The owner talks Russian: **answer the user in Russian**; code, comments, commits and docs in English.

## Architecture

```
Claude ──HTTPS──▶ host nginx (TLS, certbot) ──▶ connector :3040→3000 (OAuth + MCP)
                                                     │  http://egress:31012 (JSON API v2)
                                                     ▼
                         anytype-cli (headless Anytype) in egress's netns ──▶ tun2socks ──▶ SOCKS (VLESS) ──▶ any-sync nodes
```

| Path | Role |
|---|---|
| `src/index.ts` | Entry point: loads `.env*`, `loadConfig()`, `createApp()`, listen, graceful shutdown |
| `src/app.ts` | `createApp(config, {api?, cimdResolver?, log?})`: host validation, request log, `/`, icons, `/healthz`, `/readyz`, OAuth routes, `/mcp` |
| `src/config.ts` | `loadConfig(env)` — pure, validated; `loadEnvFiles()` |
| `src/tools.ts` | All 23 MCP tools (Anytype API v2): search/fetch/edit, collections & queries, comments & chats, templates, members. Compact JSON output, `next_offset`, markdown paging. Tool annotations are required for the directory |
| `src/hints.ts` | Turns Anytype errors/warnings (`issues[].hint` + `see_also` operationIds) into text with the next **tool** call |
| `src/anytype/client.ts` | Thin fetch client for the Anytype JSON API v2 (ETag, error passthrough) |
| `src/auth/oauth-server.ts` | Own OAuth 2.1 authorization server: CIMD (preferred) + DCR (compat), PKCE S256, RFC 9207 `iss`, RFC 8707 resource binding, rotating refresh tokens, bearer middleware, metadata |
| `src/auth/cimd.ts` | Client ID Metadata Document resolver: https-only, no redirects, public-IP check, size/time limits, cache, trust policy `CIMD_TRUSTED_HOSTS` (default `claude.ai,claude.com`) |
| `src/auth/store.ts`, `login-page.ts` | JSON-file OAuth state (DCR clients, refresh tokens, signing key) and consent/error pages |
| `src/landing-page.ts`, `public/` | Home page + icons (favicon.ico, icon.svg, icon-128.png) |
| `deploy/` | `docker-compose.yml`, `compose.proxy.yml` (blocked networks), `setup.sh`, `update.sh`, `backup.sh`, nginx template |
| `test/*.test.ts` | Unit/integration tests (`npm test`): tools vs a fake Anytype, OAuth flows, CIMD/SSRF, config, HTTP surface |
| `scripts/e2e.ts` | `npm run e2e`: in-process connector vs the real local Anytype, full create/edit/delete cycle in `API_TEST` |
| `scripts/smoke.ts`, `scripts/oauth-e2e.ts` | Checks against a running server (any URL, incl. production) |
| `tools/derive-account-key/` | Go tool: 12-word Anytype login key → `anytype-cli` account key (run offline by the user) |
| `docs/deploy.md` | Operator guide (setup, proxy overlay, updates, backups) |

Stack: Node 24 (Docker; local dev works on 22), TypeScript, Express 5, zod 4,
**MCP SDK v2** (`@modelcontextprotocol/server` + `/node`, `createMcpHandler`) serving protocol
**2026-07-28** (`server/discover`) and, statelessly, 2025-era clients. No dependency on SDK v1: the
OAuth server is our own code (`src/auth`). Scripts use `@modelcontextprotocol/client` v2.

## Commands

```bash
npm run dev                      # tsx watch; reads .env.local (API_KEY, OWNER_PASSWORD, ...)
npm run typecheck && npm test && npm run build   # tests: node:test via tsx, hermetic (fake Anytype, fake CIMD)
npm run e2e                      # every tool against the real local Anytype, writes only in space API_TEST
AUTH_DISABLED=true PORT=3100 PUBLIC_URL=http://localhost:3100 npx tsx src/index.ts   # local, no OAuth
MCP_URL=http://localhost:3100/mcp npm run smoke -- --write   # full tool cycle (needs a key that sees a space)
OWNER_PASSWORD=... BASE_URL=https://anytype.example.com npm run oauth-e2e   # 34 OAuth checks (CIMD, DCR, iss, …), works against prod
```

Releasing: bump `version` in `package.json` (+ `npm install --package-lock-only`), commit, then
`git tag vX.Y.Z && git push origin vX.Y.Z`. `.github/workflows/release.yml` checks the tag against
`package.json`, pushes `ghcr.io/hel3an/anytype-mcp-connector:{X.Y.Z,X.Y,latest}` (amd64+arm64, SBOM,
provenance), smoke-tests `/healthz` and creates a GitHub release. Production runs the released image
(`CONNECTOR_IMAGE` in `deploy/.env`); `update.sh` pulls it.

Local Anytype desktop API: `http://127.0.0.1:31009` (v2 since desktop 0.57.4). `.env.local` holds a
scoped key for the test space `API_TEST` only — do writes there, never in the owner's real spaces.

## Production (home server)

- SSH: `<user>@<server> -p <ssh-port>`. The key is in the **Windows ssh-agent**: from this Windows PC use
  `C:\Windows\System32\OpenSSH\ssh.exe` (Git Bash's `ssh` gets "Permission denied (publickey)").
  `sudo` needs the owner's password — ask the owner to run sudo steps.
- Checkout: `~/projects/anytype-mcp-connector` (read-only deploy key, SSH alias `<github-ssh-alias>`).
- Deploy/update: `cd ~/projects/anytype-mcp-connector/deploy && ./update.sh` (git pull, pull the
  released image — or rebuild when `CONNECTOR_IMAGE` is empty — `/readyz` check, automatic rollback).
  Server code changes therefore reach production only through a release tag.
- `deploy/.env` (mode 600, never print it): `DOMAIN`, `OWNER_PASSWORD`, `ANYTYPE_API_KEY`,
  `COMPOSE_FILE=docker-compose.yml:compose.proxy.yml`, `COMPOSE_PROFILES=host-proxy`,
  `HOST_PROXY_PORT=10808`, `GOOGLE_SITE_VERIFICATION`,
  `CONNECTOR_IMAGE=ghcr.io/hel3an/anytype-mcp-connector:latest` (the GHCR package is public). Read a value without printing it, e.g.
  `export OWNER_PASSWORD="$(ssh ... "grep ^OWNER_PASSWORD= .../deploy/.env | cut -d= -f2- | sed ...")"`.
- Host nginx owns 80/443 (many other sites!). Our site: `/etc/nginx/sites-available/anytype.example.com`
  → `127.0.0.1:3040`, certificate via certbot. Don't touch other sites.
- Headless Anytype runs as the **owner's own account** (account key in the `anytype-config` volume —
  treat the server and backups as sensitive). API key `claude-connector`, all spaces, read-write.
- ufw rule (added by the owner): `allow in on br-anytype-mcp to 172.31.250.1 port 10818`.
- Logs: `docker compose logs -f connector` (one line per request with JSON-RPC method/tool, no content);
  nginx access log is readable (user is in `adm`). Anthropic egress: `160.79.104.0/21`, UA `Claude-User`
  (MCP) and `python-httpx` (OAuth discovery/registration).

## Hard-won lessons (read before debugging)

**Anytype**
- API v2 is pre-release but complete: `GET object?format=md` (read-only markdown), `outline=true`,
  ETag/`If-Match`, atomic `PATCH` ops (`replace_text`, `insert_blocks` *accepts markdown*, `set_properties`, …),
  `dry_run`. Op schemas: `GET /v2/schemas/ops/{op}`. Compact search filter grammar in `/v2/schemas/filters`.
- Errors and warnings carry `issues[]` with `hint` (written as HTTP routes) and `see_also` refs
  (`{op: operationId, params, query}`); `src/hints.ts` maps operationIds to our tools — add new tools there.
- A discussion (comments) is a chat: `POST objects/{id}/discussion` is idempotent and returns the
  `chat_id`; objects expose it as `discussion`. Collections vs queries: the wrong endpoint answers 400
  with a `see_also` to the right one (`anytype_list_items` falls back automatically).
- `DELETE` only works for objects created by a **named** API key; `is_archived` is output-only, so
  objects made by an unnamed key can only be removed in the app.
- Legacy unscoped keys work but every response carries a deprecation notice; scoped keys are v2-only.
- `anytype-cli` gives every gRPC call **5 s**: the first login of a real account times out → retry
  (`setup.sh` does). The CLI refuses mnemonics; the account key is `base64(MasterNode)` derived from the
  mnemonic (`tools/derive-account-key`).
- From Russia the any-sync nodes are DPI-filtered (TCP connects, streams stall: `can't sync with peer` /
  `no recent network activity`). Fixed with `deploy/compose.proxy.yml` (tun2socks + socat bridge to the
  host's xray SOCKS). heart has **no proxy support**; prefer TCP: `ANYTYPE_PEFERYAMUXTRANSPORT=true`
  (sic — the heart field is misspelled).
- Docker blocks containers from other bridges' gateway IPs; ufw blocks container→host except opened ports.
- Anytype's data lives in the `anytype-config` volume (`/root/.config/anytype/data/<account>`), not
  `anytype-data`. A restored copy is the same device: never let it sync alongside the server
  (`deploy/compose.offline.yml`). `backup.sh` stops Anytype for ~10 s; `/readyz` is 503 meanwhile.

**MCP / Claude**
- Claude speaks MCP **2026-07-28** and probes `server/discover` first (needs `Mcp-Method` header + `_meta`
  envelope). SDK v1 answered 400 → we moved to SDK v2. The v2 SDK has **no OAuth authorization server**.
- DCR is **deprecated** in 2026-07-28 in favor of CIMD; authorization servers SHOULD send `iss` (RFC 9207).
  Claude uses CIMD only if AS metadata has `client_id_metadata_document_supported: true` **and** `none` in
  `token_endpoint_auth_methods_supported`. CIMD client ids seen in production: claude.ai/desktop/mobile `https://claude.ai/oauth/mcp-oauth-client-metadata`
  (redirect `https://claude.ai/api/mcp/auth_callback`), Claude Code `https://claude.ai/oauth/claude-code-client-metadata`.
- claude.ai answers Russian IPs with a 302 geo redirect: on the production server the connector must reach it
  through the proxy overlay (it does — connector shares egress's netns).
- Running prod `oauth-e2e` from the owner's PC shares the owner's IP; the consent limiter counts only failures,
  but don't loop it.
- Claude caches discovery metadata ~5 min.
- If a Claude surface can't connect after the CIMD switch, look for `CIMD client rejected: <url> — <reason>`
  in the connector log; a new metadata host may need adding to `CIMD_TRUSTED_HOSTS`.
- **Connector icons come from Google's favicon service** (Claude docs, "Network requirements"), not from
  the server or `serverInfo.icons`. Custom connectors show Google's favicon for the domain; Google must
  index the site first (Search Console verified via `GOOGLE_SITE_VERIFICATION`).
- Always check the latest versions/changelogs of SDKs, specs, actions and images before building on them.

**This Windows workstation / tooling**
- `TaskStop` on a background `npx tsx …` can leave the node child alive holding the port; kill by port:
  `Get-NetTCPConnection -LocalPort 3000 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`.
- WSL2 **Ubuntu-24.04** with Docker + shellcheck is installed (vhdx on D:). Use it as root, from Git Bash:
  `MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -u root -- bash -c '...'` (no sudo password needed).
  Good for shellcheck, compose checks and restore drills (offline overlay!) without touching the server.
  WSL stops when idle; containers with `restart: unless-stopped` come back on the next call.
- Foreground `sleep`-chaining is blocked; use background commands / until-loops.
- Repo enforces LF (`.gitattributes`); Python file writes must use `newline='\n'`.
- CI runs shellcheck on `deploy/*.sh` — keep it clean.

## Conventions

- Never print or commit secrets (`.env*`, keys, passwords, account key). The user once pasted keys in chat;
  don't repeat them.
- Commit messages end with the `Co-Authored-By` line from the session's attribution instructions.
- New behavior gets a test in `test/` (fake Anytype via `fakeAnytype()`, app via `createApp()` + `serve()`).
- After changing server code: typecheck → `npm test` → `npm run e2e` → commit/push → wait for CI → release tag → wait for
  the Release workflow → `update.sh` on the server → `oauth-e2e` against production.
- Keep `ROADMAP.md` checkboxes and GitHub issues in sync with reality.
