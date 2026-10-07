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
- Own OAuth server for MCP 2026-07-28: CIMD (claude.ai uses it), RFC 9207 `iss`, SDK v1 removed — #1

## Next (in order)

1. **Release pipeline** — tag → multi-arch image on GHCR → server pulls — #2
2. **Restore drill** — verify backups actually restore — #3
3. **Tests** — unit (mocked API) + e2e on the test space, in CI — #4
4. **Tool UX** — compact outputs, error hints, collections, comments/chats, `ttlMs` — #5
5. **Open source** — README, LICENSE, SECURITY, privacy policy, strip private notes — #7
6. **Directory** — Anyproto permission, submission materials — #8

## Known issues

- Connector icon depends on Google indexing the domain — #6
- Local desktop key `API_TEST` stopped resolving its space — #9
