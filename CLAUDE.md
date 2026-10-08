# CLAUDE.md — Anytype MCP connector

Guide for AI coding agents (and humans) working on this repository: what the project is, how it is
built, tested and released, and the non-obvious things learned the hard way.
Open work is tracked in **GitHub Issues** (`gh issue list`) and summarized in `ROADMAP.md`.

**Maintainer sessions:** the maintainer's deployment notes (production server, workstation) live in a
private repo. If you have access, read them too: `../anytype-mcp-ops/OPERATIONS.md`
(`gh repo clone HEL3AN/anytype-mcp-ops ../anytype-mcp-ops`). Without access, ignore this.

## What this is

A self-hosted **remote MCP server** that lets Claude (claude.ai web/desktop/mobile, Claude Code)
search, read and edit an **Anytype** workspace. Anytype is local-first and has no cloud API, so the
connector talks to a headless Anytype (`anytype-cli`) running next to it. Goal: a polished open-source
connector, eventually listed in the Claude connectors directory.

- Repo: `github.com/HEL3AN/anytype-mcp-connector` (MIT), branch `main`; images on GHCR.
- Code, comments, commits and docs are in English.

## Architecture

```
Claude ──HTTPS──▶ reverse proxy (Caddy or host nginx, TLS) ──▶ connector :3000 (OAuth + MCP)
                                                                  │  http://anytype:31012 (JSON API v2)
                                                                  ▼
                                         anytype-cli (headless Anytype) ──▶ any-sync network
                                         (optional proxy overlay: tun2socks ──▶ SOCKS, for blocked networks)
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
| `deploy/` | `docker-compose.yml`, `compose.proxy.yml` (blocked networks), `compose.offline.yml` (backup checks), `setup.sh`, `update.sh`, `backup.sh`, `restore.sh`, nginx template |
| `test/*.test.ts` | Unit/integration tests (`npm test`): tools vs a fake Anytype, OAuth flows, CIMD/SSRF, config, HTTP surface |
| `scripts/e2e.ts` | `npm run e2e`: in-process connector vs the real local Anytype, full create/edit/delete cycle in `API_TEST` |
| `scripts/smoke.ts`, `scripts/oauth-e2e.ts` | Checks against a running server (any URL, incl. production) |
| `tools/derive-account-key/` | Go tool: 12-word Anytype login key → `anytype-cli` account key (run offline by the user) |
| `docs/deploy.md` | Operator guide (setup, proxy overlay, updates, backups) |
| `README.md`, `SECURITY.md`, `PRIVACY.md`, `CONTRIBUTING.md`, `CHANGELOG.md` | Public docs; keep the tool list in README in sync with `src/tools.ts` |

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
OWNER_PASSWORD=... BASE_URL=https://your.domain npm run oauth-e2e   # 34 OAuth checks (CIMD, DCR, iss, …) against a deployment
```

Releasing: bump `version` in `package.json` (+ `npm install --package-lock-only`), add a `CHANGELOG.md`
entry, commit, then
`git tag vX.Y.Z && git push origin vX.Y.Z`. `.github/workflows/release.yml` checks the tag against
`package.json`, pushes `ghcr.io/hel3an/anytype-mcp-connector:{X.Y.Z,X.Y,latest}` (amd64+arm64, SBOM,
provenance), smoke-tests `/healthz` and creates a GitHub release. Deployments with
`CONNECTOR_IMAGE=ghcr.io/...` in `deploy/.env` get it via `update.sh`.

Local development uses the Anytype desktop API (`http://127.0.0.1:31009`, v2 since desktop 0.57.4).
Put a key **scoped to a throwaway space named `API_TEST`** in `.env.local` (`API_KEY=...`): `npm run e2e`
writes there and refuses any other space. Never point tests at real spaces.

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
- Where any-sync nodes are DPI-filtered (seen in Russia: TCP connects, streams stall: `can't sync with
  peer` / `no recent network activity`), use `deploy/compose.proxy.yml` (tun2socks + socat bridge to a
  host SOCKS proxy). heart has **no proxy support**; prefer TCP: `ANYTYPE_PEFERYAMUXTRANSPORT=true`
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
  `token_endpoint_auth_methods_supported`. CIMD client ids seen in practice: claude.ai/desktop/mobile `https://claude.ai/oauth/mcp-oauth-client-metadata`
  (redirect `https://claude.ai/api/mcp/auth_callback`), Claude Code `https://claude.ai/oauth/claude-code-client-metadata`.
- claude.ai answers some regions (e.g. Russian IPs) with a 302 geo redirect, which breaks CIMD fetches:
  there the connector must use the proxy overlay too (it shares egress's network namespace).
- `oauth-e2e` against a deployment shares your IP with the owner's browser; the consent limiter counts only
  failures, but don't loop it.
- Claude caches discovery metadata ~5 min.
- If a Claude surface can't connect after the CIMD switch, look for `CIMD client rejected: <url> — <reason>`
  in the connector log; a new metadata host may need adding to `CIMD_TRUSTED_HOSTS`.
- **Connector icons come from Google's favicon service** (Claude docs, "Network requirements"), not from
  the server or `serverInfo.icons`. Custom connectors show Google's favicon for the domain; Google must
  index the site first (Search Console verified via `GOOGLE_SITE_VERIFICATION`).
- Always check the latest versions/changelogs of SDKs, specs, actions and images before building on them.

**Tooling**
- Repo enforces LF (`.gitattributes`); Python file writes must use `newline='\n'`.
- CI runs shellcheck on `deploy/*.sh` — keep it clean.

## Conventions

- Never print or commit secrets (`.env*`, keys, passwords, account key or mnemonic).
- Commit messages end with the `Co-Authored-By` line from the session's attribution instructions.
- New behavior gets a test in `test/` (fake Anytype via `fakeAnytype()`, app via `createApp()` + `serve()`).
- After changing server code: typecheck → `npm test` → `npm run e2e` → commit/push → wait for CI → release
  tag → wait for the Release workflow → `update.sh` on the deployment → `oauth-e2e` against it.
- Keep `ROADMAP.md` checkboxes and GitHub issues in sync with reality.
