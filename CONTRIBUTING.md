# Contributing

Thanks for helping! Bug reports, ideas and pull requests are welcome.

## Getting started

Requirements: Node.js 22+ (24 recommended), the [Anytype desktop app](https://download.anytype.io)
for end-to-end tests, Docker for deployment changes.

```bash
npm install
npm run typecheck
npm test
```

`npm test` runs 100+ hermetic tests (Node's test runner via tsx): the tools against a fake Anytype API,
the OAuth server with fake clients, the CIMD resolver, config and the HTTP surface. No network needed.

### End-to-end tests against real Anytype

1. In the Anytype desktop app, create a throwaway space named **`API_TEST`**.
2. Settings → API keys: create a key scoped to that space only, read-write.
3. Put it in `.env.local` (git-ignored): `API_KEY=...`
4. `npm run e2e` — creates, edits, comments on and deletes temporary objects in `API_TEST`. It refuses
   to run against a space with any other name.

### Running the server locally

```bash
AUTH_DISABLED=true PORT=3100 npx tsx src/index.ts          # no OAuth, loopback only
MCP_URL=http://localhost:3100/mcp npm run smoke             # quick tool tour (add -- --write for writes)
```

With OAuth (`OWNER_PASSWORD` in `.env.local`), `npm run oauth-e2e` checks the authorization server
(`BASE_URL=http://localhost:3000`).

## Pull requests

- One topic per PR; describe the problem and how you tested it.
- New behavior comes with tests in `test/` (see `test/helpers.ts`: `fakeAnytype()`, `createApp()`, `serve()`).
- New tools need `title` and annotations (`readOnlyHint`, `destructiveHint`, …), a README entry, and a
  mapping in `src/hints.ts` if Anytype's hints can point to them.
- Keep `npm run typecheck`, `npm test` and `shellcheck deploy/*.sh` green — CI runs them.
- Never commit secrets: `.env*` files are git-ignored; keep it that way.

Architecture notes and hard-won lessons about Anytype and MCP are in [CLAUDE.md](CLAUDE.md).

## Releases

Maintainers bump `version` in `package.json`, add a `CHANGELOG.md` entry and push a tag `vX.Y.Z`; the
Release workflow publishes the multi-arch image to GHCR and creates a GitHub release.
