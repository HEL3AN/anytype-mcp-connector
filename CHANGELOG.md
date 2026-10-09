# Changelog

All notable changes to this project. Versions follow [semantic versioning](https://semver.org); images
are published as `ghcr.io/hel3an/anytype-mcp-connector:<version>`.

## 0.5.0 — 2026-10-09

Fewer round-trips when Claude gathers context from many pages (owner feedback: a long run of
one-page `fetch` calls in Claude Code).

- `anytype_fetch_many`: up to 10 objects of a space in one call, sharing the character budget; a
  failing object is reported in its row.
- Search rows include a short `snippet` of the body, so Claude can skip irrelevant hits.
- `anytype_fetch` lists `backlinks` (objects linking here, with names).
- Create/edit descriptions explain real object links: `<mention object_id="…">Name</mention>`
  (a markdown `[text](anytype://…)` link stays a plain URL and creates no backlink).

More of the Anytype API (36 tools):

- Schema: `anytype_create_type`, `anytype_update_type` (fields and property/view ops),
  `anytype_create_property`, `anytype_update_property`. No deletes, on purpose.
- Files: `anytype_upload_file` from a public URL (internal addresses are refused),
  `anytype_get_file` returns images as images and text files as text.
- Chats and comments: edit, delete (always asks in Claude Code), react, create a chat.
- Spaces: `anytype_get_space`, `anytype_update_space`.
- MCP prompts: weekly review, meeting notes → tasks, topic brief.

## 0.4.0 — 2026-10-08

Security hardening after an external-style review and a scan of the whole toolchain.

- Ids that are `.`/`..` are refused (they could redirect object routes to space routes).
- Prompt-injection guidance: workspace content is data, not instructions; chat/comment posting is
  marked open-world; deletion always asks in Claude Code (`anthropic/requiresUserInteraction`).
- OAuth: revoking or replaying a refresh token kills the family's access tokens immediately; global
  limit on wrong owner passwords; unused DCR clients expire; bounded pending authorizations; CIMD
  failures cached briefly; more non-public IPv6 forms blocked; malformed Basic credentials give 401;
  `client_id` is escaped in logs.
- `/mcp`: foreign browser `Origin`s refused, per-client rate limit, bounded tool input size.
- `/readyz` publicly shows only `ok` and the version.
- Containers: connector read-only, no capabilities, no-new-privileges, memory/pids limits; with the
  proxy overlay the Anytype API listens on loopback only.
- Scripts: API key no longer visible in `ps` during setup, `umask 077`, input validation.
- nginx example: HSTS and `nosniff`.
- Landing page: **Add to Claude** button (prefilled custom-connector dialog).
- Owner password compared with scrypt; runtime image without npm/yarn (no CVEs from their bundled
  dependencies), base image pinned by digest.
- CI/CD: actions pinned by SHA, least-privilege permissions, `npm audit` + signatures, dependency
  review, zizmor, Trivy (image and config), OpenSSF Scorecard, signed build provenance attestations.

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
