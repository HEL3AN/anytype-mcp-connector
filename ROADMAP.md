# Roadmap

Goal: a self-hosted remote MCP connector that lets Claude (web, desktop, mobile, Claude Code) work with
an Anytype workspace — easy to deploy, safe to expose, painless to update, good enough to publish as
open source and submit to the Claude connectors directory.

Architecture, commands and lessons learned: `CLAUDE.md`.
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
- First production deployment (maintainer's server); OAuth e2e passes against it; claude.ai connected
- CI: typecheck, build, Docker image, compose validation, shellcheck
- Home page, icons, `robots.txt`, Search Console verification hook
- Version audit (Oct 2026): Node 24, current actions/images, SDK v2
- Own OAuth server for MCP 2026-07-28: CIMD (claude.ai uses it), RFC 9207 `iss`, SDK v1 removed — #1
- Release pipeline: tag → multi-arch image on GHCR (public) → GitHub release; production pulls
  `:latest` via `update.sh` (v0.2.0) — #2
- Backups verified: production backup restored offline in a scratch Docker (173/173 objects, same
  OAuth signing key); `restore.sh`, `.env` in the archive, private archives, retention — #3
- Tests: 82 hermetic tests in CI (tools vs fake Anytype, OAuth/CIMD/SSRF, config, HTTP surface) and
  `npm run e2e` against the real Anytype test space — #4
- Tool UX: 23 tools (collections/queries, comments, chats, templates, members, schemas), compact
  output with paging hints, markdown paging, Anytype hints mapped to tool calls, cacheable tool list — #5

## Next (in order)

1. **Open source** — README, LICENSE, SECURITY, privacy policy, strip private notes — #7
2. **Directory** — Anyproto permission, submission materials — #8

3. **Owner feedback round** — refine tool descriptions from real use; links, files — #10

## Known issues

- Connector icon depends on Google indexing the domain — #6
