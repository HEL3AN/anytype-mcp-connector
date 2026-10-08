# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**[Report a vulnerability](https://github.com/HEL3AN/anytype-mcp-connector/security/advisories/new)**
(Security tab → "Report a vulnerability"). Don't open a public issue.

Include what you found, how to reproduce it and the version (`GET /healthz` shows it). You'll get an
answer within a week. Fixes ship as a new release; the advisory is published once a release is out.

Only the latest release is supported.

## Threat model

The connector is a single-owner service: one person deploys it for their own Anytype workspace.

### What an attacker would want

| Asset | Where it lives | Impact if stolen |
|---|---|---|
| Anytype **account key** (own-account setup) | `anytype-config` volume, backups | Full, irrevocable access to the Anytype account |
| Anytype API key | `deploy/.env`, backups | Read/write access to the granted spaces while the server runs |
| Owner password | `deploy/.env`, backups | Approve new OAuth clients (still needs the server) |
| OAuth signing key, refresh tokens (hashed) | `connector-data` volume | Forge or refresh access tokens for this server |

Using a **bot account** limits the first row to the spaces the bot was invited to, and you can remove
it from them at any time. Prefer it whenever the server is shared or less trusted.

### Defenses

- **OAuth 2.1 authorization server** (`src/auth`): S256 PKCE only; authorization codes are single-use
  (burned on failed exchanges) and expire after 60 s; access tokens are HMAC-signed, expire after 1 h
  and are bound to this server's MCP URL (RFC 8707); refresh tokens rotate, and reusing an old one
  revokes the whole token family, including its access tokens, immediately; RFC 9207 `iss` on every
  authorization response. Unused dynamically registered clients are dropped after a day.
- **Consent page**: every new authorization needs the owner password; failed attempts are
  rate-limited (10 per 15 minutes per IP and 30 per hour in total) and logged. Redirect URIs must match an allowlist (Claude's callbacks and
  loopback for Claude Code; extend with `EXTRA_REDIRECT_URIS`).
- **Client ID Metadata Documents** are fetched only from trusted hosts (`CIMD_TRUSTED_HOSTS`, default
  `claude.ai,claude.com`), over HTTPS on the default port, without following redirects, with a 5 s
  timeout and 64 KB limit, and only if the host resolves to public IP addresses (SSRF guard).
  Dynamic Client Registration is kept for older clients; such clients are marked unverified on the
  consent page.
- **DNS rebinding / CSRF**: requests with unexpected `Host` headers, and `/mcp` requests from foreign
  browser `Origin`s, are refused. `/mcp` is rate-limited per client.
- **Tool inputs**: ids are validated (no `.`/`..` path segments); payload size and element counts are
  bounded.
- **Prompt injection**: workspace content can be written by other members of shared spaces. The
  server instructions and read tools tell Claude to treat it as data; tools that post where others read
  (chats, comments) carry `openWorldHint`, and deletion carries `anthropic/requiresUserInteraction`.
- **Least exposure**: the Anytype API is reachable only from the connector's container network (only
  from the connector itself with the proxy overlay); the connector listens on loopback for the reverse
  proxy and runs as a non-root user with a read-only filesystem, no capabilities, no privilege
  escalation and memory/process limits. `/readyz` shows details only to local checks.
- **Supply chain**: GitHub Actions are pinned by commit SHA with least-privilege permissions; CodeQL,
  zizmor, Trivy, OpenSSF Scorecard, `npm audit` (incl. registry signatures), govulncheck and Dependabot
  run on the repository; release images carry SBOM, provenance and a signed GitHub attestation.
- **No content in logs**: one line per request (method, path, status, JSON-RPC method/tool name); no
  query strings, bodies or tokens.
- **Secrets at rest**: `deploy/.env` and backup archives are created with mode 600; backups contain
  the account key and are meant to be few (taken before Anytype updates) and encrypted when copied.

### Out of scope

- Compromise of the server itself (root access gives the account key by design).
- Claude's handling of tool results — see Anthropic's policies.
- Anytype's own sync protocol and clients — report those to [Anytype](https://github.com/anyproto).

### Operator checklist

- Use a long, unique owner password (minimum 12 characters).
- Keep the server updated and run `deploy/update.sh` for new releases.
- Prefer a bot account; with your own account, treat the server like a logged-in device.
- To cut off all Claude sessions, delete the OAuth state (see [docs/deploy.md](docs/deploy.md)); to cut
  off Anytype access, revoke the API key in `anytype-cli` or remove the bot from your spaces.
