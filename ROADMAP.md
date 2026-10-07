# Roadmap

Goal: a self-hosted remote MCP connector that lets Claude (web, desktop, mobile, Claude Code) work with
an Anytype workspace — easy to deploy on a VPS, safe to expose, painless to update, good enough to
publish as open source and submit to the Claude connectors directory.

Production target: `https://anytype.example.com/mcp`.

## Architecture (VPS)

```
Claude ──HTTPS──▶ Caddy (TLS, :443) ──▶ connector (:3000, OAuth + MCP) ──▶ anytype-cli (:31012, JSON API v2)
                                                                                    │
                                                                         any-sync network (E2E-encrypted sync)
```

Three containers in one `docker compose` project; only Caddy publishes ports. Data lives in named
volumes (`anytype-data`, `connector-data`, `caddy-data`).

## Phase 1 — Deployable stack

- [x] MCP server, Anytype v2 tools, OAuth 2.1 (DCR, PKCE, rotating refresh tokens)
- [x] Dockerfile for the connector (multi-stage, non-root, healthcheck)
- [x] `docker-compose.yml`: anytype-cli + connector + Caddy, `.env` template, pinned versions
- [x] Config for running behind a proxy (`TRUST_PROXY`), graceful shutdown, request logging
- [x] `/healthz` (liveness) and `/readyz` (Anytype reachable + key valid)
- [x] `deploy/setup.sh`: log anytype-cli in with an account key, create a scoped API key
- [x] Deployment guide (`docs/deploy.md`)

## Phase 2 — VPS rollout

- [x] DNS `anytype.example.com` → VPS (host nginx + certbot)
- [x] First deploy, Anytype login, spaces synced (through the VLESS proxy overlay)
- [x] OAuth e2e against production
- [ ] Connect from claude.ai and use it from the phone

## Phase 3 — Updates and operations

- [ ] GitHub repository, CI (typecheck, tests) on every push
- [ ] Release workflow: tag → multi-arch image on GHCR
- [x] `deploy/update.sh`: pull pinned versions, restart, verify `/readyz`, roll back on failure
- [x] Backups of volumes (`deploy/backup.sh`); restore procedure to be tested
- [x] Version shown in `/healthz` and MCP server info

## Phase 3.5 — Protocol and auth currency (MCP 2026-07-28)

- [x] Serve MCP 2026-07-28 (`server/discover`, stateless envelopes) via SDK v2, legacy 2025 clients still work
- [ ] OAuth: `iss` in authorization responses (RFC 9207) + `authorization_response_iss_parameter_supported`
- [ ] OAuth: Client ID Metadata Documents (CIMD) — DCR is deprecated in 2026-07-28
- [ ] Own authorization-server handlers, drop the v1 SDK dependency
- [ ] `ttlMs`/`cacheScope` hints for `tools/list` (static tool set)

## Phase 4 — Better tools

- [ ] Unit tests with a mocked Anytype API; e2e suite against a dedicated test space
- [ ] Compact, model-friendly outputs (search snippets, last modified, object links, pagination hints)
- [ ] Error messages with next-step hints
- [ ] Collections and lists (add/remove items, views, queries)
- [ ] Comments / discussions and chats
- [ ] Templates, file upload/download where useful
- [ ] Evaluate with real conversations and refine tool descriptions

## Phase 5 — Open source and directory

- [ ] README, LICENSE, SECURITY.md, CONTRIBUTING.md
- [ ] Privacy policy page
- [ ] CIMD (Client ID Metadata Document) support
- [ ] Icon and listing materials
- [ ] Reach out to Anyproto about a directory listing
