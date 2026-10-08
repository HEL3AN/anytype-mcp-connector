# Changelog

All notable changes to this project. Versions follow [semantic versioning](https://semver.org); images
are published as `ghcr.io/hel3an/anytype-mcp-connector:<version>`.

## 0.3.1 — 2026-10-08

- Open-source release: README, MIT license, security and privacy policies, contributing guide.
- Container logs are rotated (3 × 10 MB per service).
- `tools/derive-account-key`: dependencies updated (any-sync 0.13.7, x/crypto 0.57; btcd no longer
  needed), checked in CI with a known-answer test and govulncheck.

## 0.3.0 — 2026-10-08

- 12 new tools: collections and queries (`anytype_list_items`, `anytype_list_views`,
  `anytype_create_collection`, `anytype_create_query`), comments (`anytype_list_comments`,
  `anytype_add_comment`), chats (`anytype_list_chats`, `anytype_read_chat`, `anytype_send_chat_message`),
  `anytype_list_templates`, `anytype_list_members`, `anytype_get_schema`.
- Errors and warnings from Anytype come with the next tool call to make.
- Compact JSON output, `next_offset` for paging, long markdown is paged (`max_chars`, `start`).
- `tools/list` is cacheable for an hour (MCP 2026-07-28 cache hints).

## 0.2.1 — 2026-10-08

- Internal: `createApp()` and `loadConfig()` for testability; 82 tests in CI; `npm run e2e`.

## 0.2.0 — 2026-10-08

- Release pipeline: multi-arch images (amd64, arm64) on GHCR with SBOM and provenance.
- `update.sh` pulls released images; `restore.sh`; backups include `deploy/.env` and are private.

## 0.1.0 — 2026-10-07

- First version: 11 tools over Anytype's JSON API v2, MCP 2026-07-28 (SDK v2), own OAuth 2.1
  authorization server with Client ID Metadata Documents, Docker deployment with optional proxy overlay.
