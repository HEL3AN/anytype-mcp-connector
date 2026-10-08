<p align="center">
  <img src="public/icon-128.png" width="72" height="72" alt="">
</p>

<h1 align="center">Anytype connector for Claude</h1>

<p align="center">
  A self-hosted <a href="https://modelcontextprotocol.io">MCP</a> server that lets Claude search, read and edit your
  <a href="https://anytype.io">Anytype</a> workspace — on the web, desktop, <b>mobile</b> and in Claude Code.
</p>

<p align="center">
  <a href="https://github.com/HEL3AN/anytype-mcp-connector/actions/workflows/ci.yml"><img src="https://github.com/HEL3AN/anytype-mcp-connector/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/HEL3AN/anytype-mcp-connector/releases"><img src="https://img.shields.io/github/v/release/HEL3AN/anytype-mcp-connector" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

---

Ask Claude things like:

- *"What's on my plate this week? Check tasks that aren't done and are due before Sunday."*
- *"Read my 'Q4 planning' page and add a risks section with three bullet points."*
- *"Make a collection of everything I wrote about the garden this year."*
- *"Reply to the comments on the onboarding doc."*

## Why self-hosted

Anytype is local-first and end-to-end encrypted: there is no cloud API that Claude could call. This
connector runs Anytype's official headless client ([`anytype-cli`](https://github.com/anyproto/anytype-cli))
on your server, next to a small MCP server that Claude reaches over HTTPS:

```
Claude (web, desktop, mobile, Code)
   │  HTTPS, OAuth 2.1
   ▼
reverse proxy (bundled Caddy or your nginx)
   ▼
connector ── Anytype JSON API ──▶ anytype-cli ── encrypted sync ──▶ any-sync network ◀── your devices
```

Your notes keep syncing with your phone and laptop as usual; the server is just one more device.
Unlike the official [`anytype-mcp`](https://github.com/anyproto/anytype-mcp) (a local stdio server for
desktop apps), this one is a **remote** connector, so it also works in the Claude mobile apps.

## Tools

| Area | Tools |
|---|---|
| Find & read | `anytype_list_spaces`, `anytype_search` (full text, type, compact filters like `done = false AND due_date < currentWeek()`), `anytype_fetch` (markdown, outline or blocks; pages long bodies) |
| Edit | `anytype_create_object` (markdown body), `anytype_edit_object` (atomic ops: replace text, insert markdown, set properties, …, with `dry_run` and ETag checks), `anytype_delete_object` |
| Collections & sets | `anytype_list_items`, `anytype_list_views`, `anytype_create_collection`, `anytype_create_query` |
| Comments & chats | `anytype_list_comments`, `anytype_add_comment`, `anytype_list_chats`, `anytype_read_chat`, `anytype_send_chat_message` |
| Schema | `anytype_list_types`, `anytype_get_type`, `anytype_list_properties`, `anytype_list_property_options`, `anytype_list_templates`, `anytype_list_members`, `anytype_get_op_schema`, `anytype_get_schema` |

Every tool is annotated as read-only or as changing data, so Claude (and you) know which calls modify
your workspace. Deleting is limited to objects the connector created. When Anytype
rejects a request, the error comes back with the next tool call to make, so Claude can fix it itself.

## Quick start

You need a Linux server (1 vCPU, 1 GB RAM, amd64 or arm64) with Docker, and a domain pointing to it.

```bash
git clone https://github.com/HEL3AN/anytype-mcp-connector.git anytype-mcp
cd anytype-mcp/deploy
./setup.sh
```

`setup.sh` asks for the domain and an owner password, signs Anytype in, creates a scoped API key and
starts everything (with automatic HTTPS, or an nginx config if you already run a proxy). Then in Claude:
**Settings → Connectors → Add custom connector** → `https://<your-domain>/mcp`, and approve on the
consent page with the owner password. The connector then shows up in the Claude mobile apps as well.

Full guide — reverse proxies, blocked networks, updates, backups: [docs/deploy.md](docs/deploy.md).

### Which Anytype account?

- **A bot account** (recommended when others share the server): `setup.sh` creates one; invite it to
  the spaces Claude should see. You can remove it from a space at any time.
- **Your own account:** Claude sees all your spaces. `anytype-cli` needs an *account key*, which
  [`tools/derive-account-key`](tools/derive-account-key) derives from your 12-word login key — run it
  offline on your own computer. Treat the server like any device logged into your account.

## Updating

```bash
cd anytype-mcp/deploy && ./update.sh
```

Pulls the latest release image (or rebuilds from your checkout), checks readiness and rolls back
automatically if the new version doesn't start. Before Anytype itself is updated, it takes a backup.

## Security & privacy

- OAuth 2.1 with PKCE, Client ID Metadata Documents (how Claude identifies itself), resource-bound
  tokens and rotating refresh tokens; every new connection is approved on a consent page with the
  owner password.
- The connector stores no note content and logs no content; see [PRIVACY.md](PRIVACY.md).
- Threat model and how to report a vulnerability: [SECURITY.md](SECURITY.md).

## Limitations

- Anytype's JSON API v2 is pre-release; the connector pins a tested `anytype-cli` version.
- Anytype only lets an API key delete objects that key created.
- One owner per server (the consent password); no file uploads yet.

## Development

```bash
npm install
npm test          # 100+ hermetic tests (fake Anytype, fake OAuth clients)
npm run e2e       # every tool against your local Anytype desktop app, in a throwaway space "API_TEST"
npm run dev       # local server; see CONTRIBUTING.md
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md) (architecture and lessons learned).

## License

[MIT](LICENSE). Anytype and the Anytype logo are trademarks of Any Association; this project is not
affiliated with or endorsed by Any Association or Anthropic. The logo is used only to identify the
service the connector works with. Anytype runs unmodified from its official `anytype-cli` Docker image
(MIT), which embeds [anytype-heart](https://github.com/anyproto/anytype-heart) under the
[Any Source Available License](https://github.com/anyproto/anytype-heart/blob/main/LICENSE.md).
