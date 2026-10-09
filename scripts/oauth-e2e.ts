// Walks the OAuth flows the way Claude does, against a running server.
// Usage: OWNER_PASSWORD=... [BASE_URL=http://localhost:3000] npm run oauth-e2e
// Covers CIMD (with Claude Code's real client metadata document), DCR, PKCE, RFC 9207 `iss`,
// RFC 8707 resource binding, refresh rotation and reuse detection, and an MCP call per flow.
import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const password = process.env.OWNER_PASSWORD ?? "";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CLAUDE_CODE_CIMD = "https://claude.ai/oauth/claude-code-client-metadata";
const LOOPBACK_REDIRECT = "http://localhost:43117/callback"; // Claude Code uses an ephemeral port

let failures = 0;
function check(name: string, cond: unknown, detail: unknown = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data),
  redirect: "manual" as const,
});
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

// --- discovery ------------------------------------------------------------------------------
const unauth = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
const wwwAuth = unauth.headers.get("www-authenticate") ?? "";
check("unauthenticated /mcp -> 401", unauth.status === 401, unauth.status);
const prmUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1];
check("WWW-Authenticate has resource_metadata", !!prmUrl, wwwAuth);

const prm = await (await fetch(prmUrl!)).json();
check("PRM resource is the MCP URL", prm.resource === `${base}/mcp`, prm);
const as = await (await fetch(new URL("/.well-known/oauth-authorization-server", prm.authorization_servers[0]))).json();
check("AS metadata advertises S256", as.code_challenge_methods_supported?.includes("S256"), as);
check("AS metadata advertises CIMD", as.client_id_metadata_document_supported === true, as);
check("AS metadata allows public clients (none)", as.token_endpoint_auth_methods_supported?.includes("none"), as);
check("AS metadata advertises iss parameter", as.authorization_response_iss_parameter_supported === true, as);
check("AS metadata keeps DCR for compatibility", !!as.registration_endpoint, as);

/** Authorization request → consent page → approve; returns the parsed redirect. */
async function authorize(clientId: string, redirectUri: string, challenge: string, extra: Record<string, string> = {}) {
  const url = new URL(as.authorization_endpoint);
  const state = randomBytes(8).toString("hex");
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: (prm.scopes_supported ?? ["anytype"]).join(" "),
    resource: prm.resource,
    ...extra,
  })) url.searchParams.set(k, v);
  const page = await fetch(url, { redirect: "manual" });
  const html = await page.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  return { page, html, requestId, state };
}

async function approve(requestId: string, pw = password, access = "write") {
  const res = await fetch(`${base}/oauth/consent`, form({ request_id: requestId, password: pw, action: "approve", access }));
  return { res, location: new URL(res.headers.get("location") ?? "about:blank") };
}

async function mcpCall(accessToken: string, mode: "auto" | "legacy") {
  const client = new Client({ name: "oauth-e2e", version: "0.0.0" }, { versionNegotiation: { mode } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(prm.resource), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }),
  );
  const res = await client.callTool({ name: "anytype_list_spaces", arguments: {} });
  await client.close();
  return res;
}

// --- CIMD flow (Claude Code's real client metadata document) ---------------------------------
{
  const { verifier, challenge } = pkce();
  const auth = await authorize(CLAUDE_CODE_CIMD, LOOPBACK_REDIRECT, challenge);
  check("CIMD: authorize renders consent page", auth.page.status === 200 && !!auth.requestId, auth.page.status);
  check("CIMD: consent names the verified host", auth.html.includes("claude.ai"));
  check("CIMD: consent warns about localhost-only redirects", auth.html.includes("class=\"warn\""));

  const { res, location } = await approve(auth.requestId!);
  const code = location.searchParams.get("code");
  check("CIMD: approve redirects to the loopback URI with code", res.status === 302 && location.origin === "http://localhost:43117" && !!code, location.href);
  check("CIMD: iss equals issuer (RFC 9207)", location.searchParams.get("iss") === as.issuer, location.searchParams.get("iss"));
  check("CIMD: state preserved", location.searchParams.get("state") === auth.state);

  const tok = await fetch(as.token_endpoint, form({ grant_type: "authorization_code", client_id: CLAUDE_CODE_CIMD, code: code!, code_verifier: verifier, redirect_uri: LOOPBACK_REDIRECT, resource: prm.resource }));
  const tokens = await tok.json();
  check("CIMD: public client exchanges code (no secret)", tok.status === 200 && !!tokens.access_token, tokens);
  const call = await mcpCall(tokens.access_token, "auto");
  check("CIMD: MCP tool call works (2026-07-28 negotiation)", !call.isError, call.content);

  const refreshed = await fetch(as.token_endpoint, form({ grant_type: "refresh_token", client_id: CLAUDE_CODE_CIMD, refresh_token: tokens.refresh_token }));
  check("CIMD: refresh works", refreshed.status === 200, await refreshed.text());
}

// --- read-only connection: the owner picks "Read only" on the consent page --------------------
{
  const { verifier, challenge } = pkce();
  const auth = await authorize(CLAUDE_CODE_CIMD, LOOPBACK_REDIRECT, challenge);
  check("consent offers read-only access", auth.html.includes('value="read"'));
  const { location } = await approve(auth.requestId!, password, "read");
  const tok = await fetch(as.token_endpoint, form({ grant_type: "authorization_code", client_id: CLAUDE_CODE_CIMD, code: location.searchParams.get("code")!, code_verifier: verifier, redirect_uri: LOOPBACK_REDIRECT, resource: prm.resource }));
  const tokens = await tok.json();
  check("read-only: token carries only the read scope", tokens.scope === "anytype:read", tokens.scope);
  const client = new Client({ name: "oauth-e2e", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(prm.resource), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }),
  );
  const { tools } = await client.listTools();
  await client.close();
  check("read-only: only read-only tools are listed", tools.length > 0 && tools.every((t) => t.annotations?.readOnlyHint === true), tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name));
}

{
  const { challenge } = pkce();
  const untrusted = await authorize("https://example.com/oauth/client.json", "https://example.com/cb", challenge);
  check("CIMD: untrusted metadata host rejected without redirect", untrusted.page.status === 400 && !untrusted.page.headers.get("location"), untrusted.page.status);
  const badRedirect = await authorize(CLAUDE_CODE_CIMD, "https://evil.example/cb", challenge);
  check("CIMD: redirect_uri outside the document rejected", badRedirect.page.status === 400, badRedirect.page.status);
}

// --- DCR flow (deprecated, kept for compatibility) ---------------------------------------------
const evil = await fetch(as.registration_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ client_name: "evil", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }),
});
check("DCR rejects foreign redirect_uri", evil.status === 400, evil.status);

const reg = await fetch(as.registration_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ client_name: "Claude (e2e)", redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
});
const client = await reg.json();
check("DCR registers public client", reg.status === 201 && !!client.client_id && !client.client_secret, client);

{
  const { challenge } = pkce();
  const wrongTarget = await authorize(client.client_id, CLAUDE_REDIRECT, challenge, { resource: "https://other.example/mcp" });
  const loc = new URL(wrongTarget.page.headers.get("location") ?? "about:blank");
  check("foreign resource -> invalid_target redirect with iss", loc.searchParams.get("error") === "invalid_target" && loc.searchParams.get("iss") === as.issuer, loc.href);
}

const { verifier, challenge } = pkce();
const auth = await authorize(client.client_id, CLAUDE_REDIRECT, challenge);
check("DCR: consent marks the name as self-declared", auth.html.includes("self-declared"));
const wrong = await fetch(`${base}/oauth/consent`, form({ request_id: auth.requestId!, password: "wrong-password!", action: "approve" }));
check("wrong password -> 401", wrong.status === 401, wrong.status);
const { res: approved, location } = await approve(auth.requestId!);
const code = location.searchParams.get("code");
check("DCR: approve redirects to Claude with code and iss", approved.status === 302 && location.origin === "https://claude.ai" && !!code && location.searchParams.get("iss") === as.issuer, location.href);

const badPkce = await fetch(as.token_endpoint, form({ grant_type: "authorization_code", client_id: client.client_id, code: code!, code_verifier: "x".repeat(43), redirect_uri: CLAUDE_REDIRECT }));
check("wrong code_verifier rejected (and burns the code)", badPkce.status === 400, await badPkce.text());

// The failed attempt consumed the code; run a fresh authorization for the token tests.
const auth2 = await authorize(client.client_id, CLAUDE_REDIRECT, challenge);
const code2 = (await approve(auth2.requestId!)).location.searchParams.get("code")!;
const tokRes = await fetch(as.token_endpoint, form({ grant_type: "authorization_code", client_id: client.client_id, code: code2, code_verifier: verifier, redirect_uri: CLAUDE_REDIRECT, resource: prm.resource }));
const tokens = await tokRes.json();
check("code exchanged for tokens", tokRes.status === 200 && !!tokens.access_token && !!tokens.refresh_token, tokens);

const replay = await fetch(as.token_endpoint, form({ grant_type: "authorization_code", client_id: client.client_id, code: code2, code_verifier: verifier, redirect_uri: CLAUDE_REDIRECT }));
check("authorization code is single-use", replay.status === 400, replay.status);

const legacyCall = await mcpCall(tokens.access_token, "legacy");
check("authenticated tool call works (2025 initialize)", !legacyCall.isError, legacyCall.content);

const tampered = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tokens.access_token}x` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
check("tampered token -> 401", tampered.status === 401, tampered.status);

const r1 = await fetch(as.token_endpoint, form({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token }));
const t2 = await r1.json();
check("refresh returns new tokens", r1.status === 200 && t2.refresh_token && t2.refresh_token !== tokens.refresh_token, t2);
const reuse = await fetch(as.token_endpoint, form({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token }));
const reuseBody = await reuse.json();
check("reused refresh token -> invalid_grant", reuse.status === 400 && reuseBody.error === "invalid_grant", reuseBody);
const afterReuse = await fetch(as.token_endpoint, form({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: t2.refresh_token }));
check("reuse revokes the whole token family", afterReuse.status === 400, afterReuse.status);

const deny = await authorize(client.client_id, CLAUDE_REDIRECT, challenge);
const denied = await fetch(`${base}/oauth/consent`, form({ request_id: deny.requestId!, action: "deny" }));
const deniedLoc = new URL(denied.headers.get("location") ?? "about:blank");
check("deny -> access_denied redirect with iss", deniedLoc.searchParams.get("error") === "access_denied" && deniedLoc.searchParams.get("iss") === as.issuer, deniedLoc.href);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
