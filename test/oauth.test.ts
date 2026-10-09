// OAuth authorization server over HTTP: CIMD and DCR clients, consent, PKCE, iss, resource binding,
// refresh rotation and reuse detection, bearer validation. CIMD documents come from a fake fetch.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import express from "express";
import { CimdResolver } from "../src/auth/cimd.js";
import { OAuthServer, type OAuthServerOptions, pkceMatches, redirectUriMatches } from "../src/auth/oauth-server.js";
import { serve, tempDir } from "./helpers.js";

const PASSWORD = "correct horse battery";
const ISSUER = "https://mcp.example.test/";
const RESOURCE = "https://mcp.example.test/mcp";
const CLAUDE_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CODE_ID = "https://claude.ai/oauth/claude-code-client-metadata";
const LOOPBACK_REDIRECT = "http://localhost/callback";

const documents: Record<string, unknown> = {
  [CLAUDE_ID]: { client_id: CLAUDE_ID, client_name: "Claude", redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "none" },
  [CODE_ID]: { client_id: CODE_ID, client_name: "Claude Code", redirect_uris: [LOOPBACK_REDIRECT] },
};
const fakeFetch = (async (input: URL | RequestInfo) => {
  const doc = documents[String(input)];
  return doc ? Response.json(doc) : new Response("not found", { status: 404 });
}) as typeof fetch;

function options(dataDir: string, overrides: Partial<OAuthServerOptions> = {}): OAuthServerOptions {
  return {
    issuer: new URL(ISSUER),
    resource: new URL(RESOURCE),
    dataDir,
    ownerPassword: PASSWORD,
    scopes: ["anytype:read", "anytype:write"],
    accessTokenTtlSec: 3600,
    refreshTokenTtlSec: 86400,
    allowedRedirectUris: [CLAUDE_REDIRECT, LOOPBACK_REDIRECT],
    cimdTrustedHosts: ["claude.ai"],
    cimdResolver: new CimdResolver(["claude.ai"], fakeFetch, async () => ["160.79.104.10"]),
    ...overrides,
  };
}

async function startServer(opts: OAuthServerOptions) {
  const oauth = new OAuthServer(opts);
  const app = express();
  app.use(oauth.router());
  app.all("/mcp", oauth.bearer(), (req, res) => res.json({ auth: (req as unknown as { auth: unknown }).auth }));
  return { oauth, ...(await serve(app)) };
}

const data = tempDir();
let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer(options(data.dir));
});
after(async () => {
  await srv.close();
  data.cleanup();
});

// --- protocol helpers -------------------------------------------------------------------------

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function authorize(params: Record<string, string>) {
  const res = await fetch(`${srv.url}/authorize?${new URLSearchParams(params)}`, { redirect: "manual" });
  const html = await res.text();
  return { res, html, requestId: /name="request_id" value="([^"]+)"/.exec(html)?.[1] };
}

async function consent(requestId: string, action: "approve" | "deny", password = PASSWORD) {
  const res = await fetch(`${srv.url}/oauth/consent`, {
    method: "POST",
    body: new URLSearchParams({ request_id: requestId, action, password }),
    redirect: "manual",
  });
  const location = res.headers.get("location");
  return { res, location: location ? new URL(location) : undefined };
}

async function token(form: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/token`, { method: "POST", body: new URLSearchParams(form), headers });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

/** Runs the whole authorization code flow and returns the token response. */
async function login(clientId = CLAUDE_ID, redirectUri = CLAUDE_REDIRECT) {
  const { verifier, challenge } = pkce();
  const { requestId } = await authorize({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st",
    resource: RESOURCE,
  });
  assert.ok(requestId, "consent page rendered");
  const { location } = await consent(requestId, "approve");
  const code = location?.searchParams.get("code");
  assert.ok(code, "redirected with a code");
  const tokens = await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri });
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
  return tokens.body;
}

const mcp = (accessToken?: string) =>
  fetch(`${srv.url}/mcp`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });

// --- tests --------------------------------------------------------------------------------------

describe("helpers", () => {
  test("redirectUriMatches: exact, or loopback on any port", () => {
    assert.ok(redirectUriMatches(CLAUDE_REDIRECT, CLAUDE_REDIRECT));
    assert.ok(redirectUriMatches("http://localhost:43117/callback", LOOPBACK_REDIRECT));
    assert.ok(redirectUriMatches("http://127.0.0.1:5000/callback", "http://127.0.0.1/callback"));
    assert.ok(!redirectUriMatches("http://localhost:43117/other", LOOPBACK_REDIRECT));
    assert.ok(!redirectUriMatches("http://localhost.evil.test/callback", LOOPBACK_REDIRECT));
    assert.ok(!redirectUriMatches("https://claude.ai:444/api/mcp/auth_callback", CLAUDE_REDIRECT));
    assert.ok(!redirectUriMatches("https://claude.ai/api/mcp/auth_callback?x=1", CLAUDE_REDIRECT));
    assert.ok(!redirectUriMatches("not a url", CLAUDE_REDIRECT));
  });

  test("pkceMatches: S256 only, verifier syntax enforced", () => {
    const { verifier, challenge } = pkce();
    assert.ok(pkceMatches(verifier, challenge));
    assert.ok(!pkceMatches(verifier, pkce().challenge));
    assert.ok(!pkceMatches(challenge, challenge), "plain method is not accepted");
    assert.ok(!pkceMatches("short", createHash("sha256").update("short").digest("base64url")));
  });
});

describe("metadata", () => {
  test("authorization server metadata advertises CIMD, public clients, S256 and iss", async () => {
    const meta = (await (await fetch(`${srv.url}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    assert.equal(meta.issuer, ISSUER);
    assert.equal(meta.client_id_metadata_document_supported, true);
    assert.equal(meta.authorization_response_iss_parameter_supported, true);
    assert.ok((meta.token_endpoint_auth_methods_supported as string[]).includes("none"));
    assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
  });

  test("protected resource metadata is served at the path-specific and root URLs", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const meta = (await (await fetch(srv.url + path)).json()) as Record<string, unknown>;
      assert.equal(meta.resource, RESOURCE);
      assert.deepEqual(meta.authorization_servers, [ISSUER]);
    }
  });
});

describe("authorization with a CIMD client (claude.ai)", () => {
  test("full flow: consent, code with iss and state, tokens, MCP access", async () => {
    const tokens = await login();
    assert.equal(tokens.token_type, "Bearer");
    assert.equal(tokens.scope, "anytype:read anytype:write");
    const res = await mcp(tokens.access_token);
    assert.equal(res.status, 200);
    const { auth } = (await res.json()) as { auth: { clientId: string; scopes: string[] } };
    assert.equal(auth.clientId, CLAUDE_ID);
    assert.deepEqual(auth.scopes, ["anytype:read", "anytype:write"]);
  });

  test("redirects carry iss and state", async () => {
    const { challenge } = pkce();
    const { requestId } = await authorize({
      response_type: "code",
      client_id: CLAUDE_ID,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
    });
    const { location } = await consent(requestId!, "approve");
    assert.equal(location?.origin + location!.pathname, CLAUDE_REDIRECT);
    assert.equal(location?.searchParams.get("iss"), ISSUER);
    assert.equal(location?.searchParams.get("state"), "xyz");
  });

  test("the consent page names the verified client host", async () => {
    const { html } = await authorize({ response_type: "code", client_id: CLAUDE_ID, code_challenge: pkce().challenge, code_challenge_method: "S256" });
    assert.match(html, /Claude \(claude\.ai\)/);
  });

  test("Claude Code on an ephemeral loopback port", async () => {
    const tokens = await login(CODE_ID, "http://localhost:43117/callback");
    assert.ok(tokens.access_token);
  });

  test("wrong password re-renders the form (401), deny redirects with access_denied", async () => {
    const { requestId } = await authorize({ response_type: "code", client_id: CLAUDE_ID, code_challenge: pkce().challenge, code_challenge_method: "S256" });
    const wrong = await consent(requestId!, "approve", "wrong password!!");
    assert.equal(wrong.res.status, 401);
    assert.match(await wrong.res.text(), /Wrong password/);
    const denied = await consent(requestId!, "deny");
    assert.equal(denied.location?.searchParams.get("error"), "access_denied");
    assert.equal(denied.location?.searchParams.get("iss"), ISSUER);
    const again = await consent(requestId!, "approve");
    assert.equal(again.res.status, 400, "a finished request cannot be reused");
  });

  test("a foreign resource is refused with invalid_target", async () => {
    const { res } = await authorize({
      response_type: "code",
      client_id: CLAUDE_ID,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      resource: "https://other.example.test/mcp",
    });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get("location")!);
    assert.equal(location.searchParams.get("error"), "invalid_target");
    assert.equal(location.searchParams.get("iss"), ISSUER);
  });

  test("PKCE is required", async () => {
    const { res } = await authorize({ response_type: "code", client_id: CLAUDE_ID });
    assert.equal(new URL(res.headers.get("location")!).searchParams.get("error"), "invalid_request");
  });

  test("clients and redirect URIs that can't be verified get an error page, never a redirect", async () => {
    const cases: Record<string, string>[] = [
      { client_id: "https://evil.example.test/oauth/client" }, // untrusted metadata host
      { client_id: "https://claude.ai/oauth/missing-document" }, // 404
      { client_id: CLAUDE_ID, redirect_uri: "https://evil.example.test/callback" }, // not in the document
      { client_id: "unknown-dcr-client" },
    ];
    for (const params of cases) {
      const { res } = await authorize({ response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256", ...params });
      assert.equal(res.status, 400, JSON.stringify(params));
      assert.equal(res.headers.get("location"), null);
    }
  });
});

describe("token endpoint", () => {
  async function codeFor(clientId = CLAUDE_ID) {
    const p = pkce();
    const { requestId } = await authorize({ response_type: "code", client_id: clientId, code_challenge: p.challenge, code_challenge_method: "S256" });
    const { location } = await consent(requestId!, "approve");
    return { ...p, code: location!.searchParams.get("code")! };
  }

  test("codes are single use", async () => {
    const { code, verifier } = await codeFor();
    const form = { grant_type: "authorization_code", client_id: CLAUDE_ID, code, code_verifier: verifier };
    assert.equal((await token(form)).status, 200);
    const reuse = await token(form);
    assert.equal(reuse.status, 400);
    assert.equal(reuse.body.error, "invalid_grant");
  });

  test("a wrong code_verifier fails and burns the code", async () => {
    const { code, verifier } = await codeFor();
    const bad = await token({ grant_type: "authorization_code", client_id: CLAUDE_ID, code, code_verifier: pkce().verifier });
    assert.equal(bad.body.error, "invalid_grant");
    const good = await token({ grant_type: "authorization_code", client_id: CLAUDE_ID, code, code_verifier: verifier });
    assert.equal(good.body.error, "invalid_grant");
  });

  test("a code can't be redeemed by another client", async () => {
    const { code, verifier } = await codeFor();
    const res = await token({ grant_type: "authorization_code", client_id: CODE_ID, code, code_verifier: verifier });
    assert.equal(res.body.error, "invalid_grant");
  });

  test("refresh tokens rotate; reusing an old one revokes the whole family", async () => {
    const first = await login();
    const second = await token({ grant_type: "refresh_token", client_id: CLAUDE_ID, refresh_token: first.refresh_token! });
    assert.equal(second.status, 200);
    assert.notEqual(second.body.refresh_token, first.refresh_token);

    const replay = await token({ grant_type: "refresh_token", client_id: CLAUDE_ID, refresh_token: first.refresh_token! });
    assert.equal(replay.body.error, "invalid_grant");
    const afterReplay = await token({ grant_type: "refresh_token", client_id: CLAUDE_ID, refresh_token: second.body.refresh_token! });
    assert.equal(afterReplay.body.error, "invalid_grant", "the newest token of the family is revoked too");
  });

  test("revoke ends the refresh token family", async () => {
    const tokens = await login();
    const res = await fetch(`${srv.url}/revoke`, {
      method: "POST",
      body: new URLSearchParams({ client_id: CLAUDE_ID, token: tokens.refresh_token! }),
    });
    assert.equal(res.status, 200);
    const refresh = await token({ grant_type: "refresh_token", client_id: CLAUDE_ID, refresh_token: tokens.refresh_token! });
    assert.equal(refresh.body.error, "invalid_grant");
  });

  test("unsupported grant types are refused", async () => {
    const res = await token({ grant_type: "password", client_id: CLAUDE_ID });
    assert.equal(res.body.error, "unsupported_grant_type");
  });
});

describe("dynamic client registration (compatibility)", () => {
  const register = (body: unknown) =>
    fetch(`${srv.url}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  test("redirect URIs outside the allowlist are refused", async () => {
    const res = await register({ redirect_uris: ["https://evil.example.test/cb"], client_name: "x" });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_redirect_uri");
  });

  test("a confidential client must authenticate at the token endpoint", async () => {
    const res = await register({ redirect_uris: [CLAUDE_REDIRECT], client_name: "Old Claude" });
    assert.equal(res.status, 201);
    const client = (await res.json()) as { client_id: string; client_secret: string };
    assert.ok(client.client_secret);

    const p = pkce();
    const { requestId, html } = await authorize({ response_type: "code", client_id: client.client_id, code_challenge: p.challenge, code_challenge_method: "S256" });
    assert.match(html, /Old Claude/);
    const { location } = await consent(requestId!, "approve");
    const code = location!.searchParams.get("code")!;
    const basic = (secret: string) => ({ Authorization: `Basic ${Buffer.from(`${client.client_id}:${secret}`).toString("base64")}` });

    const wrong = await token({ grant_type: "authorization_code", code, code_verifier: p.verifier }, basic("nope"));
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, "invalid_client");
    // Client authentication fails before the code is looked at, so the code is still valid.
    const ok = await token({ grant_type: "authorization_code", code, code_verifier: p.verifier }, basic(client.client_secret));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });
});

describe("bearer middleware", () => {
  test("no token: 401 with a resource_metadata challenge", async () => {
    const res = await mcp();
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  test("tampered and malformed tokens are rejected", async () => {
    const { access_token } = await login();
    const [payload, sig] = access_token!.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), scp: ["admin"] })).toString("base64url");
    for (const bad of [`${forged}.${sig}`, "garbage", `${payload}.`]) {
      assert.equal((await mcp(bad)).status, 401, bad.slice(0, 20));
    }
  });

  test("tokens are bound to the resource", async () => {
    const { access_token } = await login();
    const other = new OAuthServer(options(data.dir, { resource: new URL("https://mcp.example.test/other") }));
    await assert.rejects(other.verifyAccessToken(access_token!), /not issued for this resource/);
  });

  test("expired tokens are rejected", async () => {
    const dir = tempDir();
    const short = await startServer(options(dir.dir, { accessTokenTtlSec: -1 }));
    try {
      const prev = srv;
      srv = short;
      try {
        const { access_token } = await login();
        await assert.rejects(short.oauth.verifyAccessToken(access_token!), /expired/);
      } finally {
        srv = prev;
      }
    } finally {
      await short.close();
      dir.cleanup();
    }
  });

  test("the signing key survives a restart (same data dir)", async () => {
    const tokens = await login();
    const restarted = new OAuthServer(options(data.dir));
    const auth = await restarted.verifyAccessToken(tokens.access_token!);
    assert.equal(auth.clientId, CLAUDE_ID);
  });
});

describe("revocation and robustness", () => {
  test("revoking a refresh token invalidates its access tokens immediately", async () => {
    const tokens = await login();
    assert.equal((await mcp(tokens.access_token)).status, 200);
    await fetch(`${srv.url}/revoke`, { method: "POST", body: new URLSearchParams({ client_id: CLAUDE_ID, token: tokens.refresh_token! }) });
    assert.equal((await mcp(tokens.access_token)).status, 401);
  });

  test("a replayed refresh token also kills the family's access tokens", async () => {
    const first = await login();
    const second = await token({ grant_type: "refresh_token", client_id: CLAUDE_ID, refresh_token: first.refresh_token! });
    assert.equal((await mcp(second.body.access_token)).status, 200);
    await token({ grant_type: "refresh_token", client_id: CLAUDE_ID, refresh_token: first.refresh_token! });
    assert.equal((await mcp(second.body.access_token)).status, 401);
  });

  test("malformed Basic credentials are a 401, not a server error", async () => {
    const res = await token({ grant_type: "refresh_token", refresh_token: "x" }, { Authorization: `Basic ${Buffer.from("%E0%A4%A:x").toString("base64")}` });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "invalid_client");
  });
});
