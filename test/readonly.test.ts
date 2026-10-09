// Access levels end to end: the owner picks "read only" on the consent page, and that connection's MCP
// server lists and runs only the read-only tools.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createApp } from "../src/app.js";
import { CimdResolver } from "../src/auth/cimd.js";
import { canWrite, normalizeScopes } from "../src/auth/scopes.js";
import { fakeAnytype, mcpClient, serve, tempDir, testConfig } from "./helpers.js";

const CLAUDE_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const RESOURCE = "https://mcp.example.test/mcp";

const fakeFetch = (async () =>
  Response.json({
    client_id: CLAUDE_ID,
    client_name: "Claude",
    redirect_uris: [CLAUDE_REDIRECT],
    token_endpoint_auth_method: "none",
  })) as unknown as typeof fetch;

const data = tempDir();
let anytype: Awaited<ReturnType<typeof fakeAnytype>>;
let server: Awaited<ReturnType<typeof serve>>;

before(async () => {
  anytype = await fakeAnytype();
  const config = testConfig({ ANYTYPE_API_URL: anytype.url, DATA_DIR: data.dir, PUBLIC_URL: "https://mcp.example.test" });
  const cimdResolver = new CimdResolver(["claude.ai"], fakeFetch, async () => ["160.79.104.10"]);
  server = await serve(createApp(config, { cimdResolver, log: () => {} }).app);
});

after(async () => {
  await server.close();
  await anytype.close();
  data.cleanup();
});

/** Authorization code flow with the given consent choice; returns the token response. */
async function login(access: "read" | "write" | undefined, scope?: string) {
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLAUDE_ID,
    redirect_uri: CLAUDE_REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: RESOURCE,
    ...(scope ? { scope } : {}),
  });
  const page = await (await fetch(`${server.url}/authorize?${params}`)).text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(page)?.[1];
  assert.ok(requestId, "consent page");
  const consent = await fetch(`${server.url}/oauth/consent`, {
    method: "POST",
    body: new URLSearchParams({ request_id: requestId, action: "approve", password: "correct horse battery", ...(access ? { access } : {}) }),
    redirect: "manual",
  });
  const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;
  const res = await fetch(`${server.url}/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLAUDE_ID, code, code_verifier: verifier, redirect_uri: CLAUDE_REDIRECT }),
  });
  assert.equal(res.status, 200);
  return { page, tokens: (await res.json()) as Record<string, string> };
}

async function refresh(refreshToken: string, scope?: string) {
  const res = await fetch(`${server.url}/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLAUDE_ID, refresh_token: refreshToken, ...(scope ? { scope } : {}) }),
  });
  return (await res.json()) as Record<string, string>;
}

describe("scopes", () => {
  test("the legacy scope means full access; write implies read; unknown scopes are dropped", () => {
    assert.deepEqual(normalizeScopes(["anytype"]), ["anytype:read", "anytype:write"]);
    assert.deepEqual(normalizeScopes(["anytype:write"]), ["anytype:read", "anytype:write"]);
    assert.deepEqual(normalizeScopes(["anytype:read", "other"]), ["anytype:read"]);
    assert.deepEqual(normalizeScopes([]), []);
    assert.equal(canWrite(["anytype"]), true);
    assert.equal(canWrite(["anytype:read"]), false);
  });
});

describe("access level chosen on the consent page", () => {
  test("the consent page offers both levels, read and edit preselected", async () => {
    const { page, tokens } = await login(undefined);
    assert.match(page, /wants to read and edit/);
    assert.match(page, /value="write" checked/);
    assert.equal(tokens.scope, "anytype:read anytype:write");
  });

  test("a client asking only for read gets no choice", async () => {
    const { page, tokens } = await login(undefined, "anytype:read");
    assert.match(page, /wants to read objects/);
    assert.doesNotMatch(page, /value="write"/);
    assert.equal(tokens.scope, "anytype:read");
  });

  test("read only: write tools are neither listed nor callable, and refresh can't widen it", async () => {
    const { tokens } = await login("read");
    assert.equal(tokens.scope, "anytype:read");

    const client = await mcpClient(`${server.url}/mcp`, tokens.access_token);
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.length > 10);
      assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true), "only read-only tools");
      assert.ok(!tools.some((t) => t.name === "anytype_create_object"));
      await assert.rejects(
        client.callTool({ name: "anytype_create_object", arguments: { space_id: "s", type: "page" } }),
        /anytype_create_object disabled/,
      );
      assert.equal(anytype.requests.filter((r) => r.method !== "GET").length, 0, "nothing reached Anytype");
      const card = await client.callTool({ name: "anytype_show_objects", arguments: { space_id: "s", object_ids: ["a"] } });
      assert.equal((card.structuredContent as { can_edit: boolean }).can_edit, false, "card checkboxes are read-only");
      const { prompts } = await client.listPrompts();
      assert.ok(!prompts.some((p) => p.name === "meeting_to_tasks"), "no prompt that writes");
    } finally {
      await client.close();
    }

    const refreshed = await refresh(tokens.refresh_token!, "anytype:read anytype:write");
    assert.equal(refreshed.scope, "anytype:read");
  });

  test("read and edit: all tools are listed", async () => {
    const { tokens } = await login("write");
    const client = await mcpClient(`${server.url}/mcp`, tokens.access_token);
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "anytype_create_object"));
      assert.ok(tools.some((t) => t.name === "anytype_delete_object"));
    } finally {
      await client.close();
    }
  });
});
