# Privacy policy

*Last updated: 2026-10-08*

The Anytype connector for Claude is **self-hosted software**. Whoever deploys it (the *operator*) runs
it on their own server for their own Anytype workspace. The project's authors do not operate a shared
service and do not receive any data from your deployment.

## What the connector does with your data

When you use Claude with the connector, Claude calls the connector's tools (search, read, create,
edit, comment, …). For each call the connector:

1. checks Claude's access token,
2. forwards the request to the Anytype client on the same server,
3. returns Anytype's answer to Claude.

The content of your notes passes through the connector **in memory only**. The connector does not
store, cache or log it. This includes files Claude reads (`anytype_get_file`): images and text files
are passed to Claude as they are.

When Claude stores a file from a web address (`anytype_upload_file`), the **Anytype client on your
server downloads it** from that address. The connector allows only public http(s) addresses, so the
server's internal network can't be reached this way.

## What is stored on the server

| Data | Purpose | Retention |
|---|---|---|
| Anytype's local data (your synced spaces, end-to-end encrypted on the network) | Anytype works as one more of your devices | Until the operator removes the server |
| OAuth state: registered client ids and names, hashes of refresh tokens, a signing key | Keep Claude connected | Refresh tokens expire after 30 days; revoked on request |
| Configuration (`deploy/.env`): domain, owner password, Anytype API key | Run the service | Until changed by the operator |
| Request log: time, method, path, status, duration, JSON-RPC method or tool name | Operations and debugging | Rotated: at most 3 files × 10 MB per container |

The request log contains **no** note content, search queries, query strings, tokens or IP addresses.
The operator's reverse proxy (Caddy or nginx) may keep its own access logs with IP addresses, under
the operator's configuration.

Backups made with `deploy/backup.sh` contain everything in the table above and stay on the server
unless the operator copies them elsewhere.

## Who else receives data

- **Anthropic (Claude):** tool results are sent to Claude as part of your conversation and are
  handled under [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).
- **Anytype's sync network (any-sync):** Anytype syncs your spaces end-to-end encrypted, as on any
  other device. See [Anytype's terms](https://anytype.io/terms_of_use) and the privacy policy they refer to.
- **claude.ai:** when Claude connects, the connector downloads Claude's public OAuth client
  description from claude.ai. No user data is sent.

There are no analytics, cookies, advertising or other third parties.

## Your choices

- Disconnect the connector in Claude's settings at any time.
- The operator can revoke all Claude sessions, revoke the Anytype API key, or remove the server.
- With a bot account, removing the bot from a space ends the connector's access to it.

## Contact

For your deployment, contact its operator. For the software itself, open an issue at
[github.com/HEL3AN/anytype-mcp-connector](https://github.com/HEL3AN/anytype-mcp-connector/issues);
for security issues see [SECURITY.md](SECURITY.md).
