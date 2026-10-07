# Roadmap

Goal: a self-hosted remote MCP connector that lets Claude (web, desktop, mobile, Claude Code) work with
an Anytype workspace — easy to deploy, safe to expose, painless to update, good enough to publish as
open source and submit to the Claude connectors directory.

Production: `https://anytype.example.com/mcp`. Details, commands and lessons learned: `CLAUDE.md`.
Each open item links to a GitHub issue with context and a definition of done.

## Done

- MCP server with 11 Anytype v2 tools (search, fetch as markdown/outline/blocks, types, properties,
  options, op schemas, create with markdown, atomic edit ops, delete), tool annotations
- MCP protocol 2026-07-28 (`server/discover`) via SDK v2; 2025-era clients served statelessly
- OAuth 2.1 for the owner: DCR, S256 PKCE, consent page with owner password, 1 h access tokens bound to
  the resource, rotating refresh tokens with reuse detection, redirect allowlist
- Docker stack (anytype-cli + connector, optional Caddy), `setup.sh` / `update.sh` (readiness check +
  rollback) / `backup.sh`, nginx template, docs
- Proxy overlay for networks where Anytype sync is blocked (tun2socks + host SOCKS bridge)
- Production rollout on the home server; OAuth e2e passes against production; claude.ai connected
- CI: typecheck, build, Docker image, compose validation, shellcheck
- Home page, icons, `robots.txt`, Search Console verification hook
- Version audit (Oct 2026): Node 24, current actions/images, SDK v2

## Next (in order)

1. **OAuth currency** — CIMD, `iss` (RFC 9207), own authorization server, drop SDK v1 — #1 *(in progress)*
2. **Release pipeline** — tag → multi-arch image on GHCR → server pulls — #2
3. **Restore drill** — verify backups actually restore — #3
4. **Tests** — unit (mocked API) + e2e on the test space, in CI — #4
5. **Tool UX** — compact outputs, error hints, collections, comments/chats, `ttlMs` — #5
6. **Open source** — README, LICENSE, SECURITY, privacy policy, strip private notes — #7
7. **Directory** — Anyproto permission, submission materials — #8

## Known issues

- Connector icon depends on Google indexing the domain — #6
- Local desktop key `API_TEST` stopped resolving its space — #9
