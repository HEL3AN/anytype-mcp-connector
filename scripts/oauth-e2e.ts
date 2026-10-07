// Walks the OAuth flow the way Claude does, against a running server.
// Usage: OWNER_PASSWORD=... [BASE_URL=http://localhost:3000] npm run oauth-e2e
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const password = process.env.OWNER_PASSWORD ?? "";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let failures = 0;
function check(name: string, cond: boolean, detail: unknown = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data),
  redirect: "manual" as const,
});

// 1. Unauthenticated MCP call -> 401 pointing at protected resource metadata
const unauth = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
const wwwAuth = unauth.headers.get("www-authenticate") ?? "";
check("unauthenticated /mcp -> 401", unauth.status === 401, unauth.status);
const prmUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1];
check("WWW-Authenticate has resource_metadata", !!prmUrl, wwwAuth);

// 2. Discovery
const prm = await (await fetch(prmUrl!)).json();
check("PRM resource is the MCP URL", prm.resource === `${base}/mcp`, prm);
const asMeta = await (await fetch(new URL("/.well-known/oauth-authorization-server", prm.authorization_servers[0]))).json();
check("AS metadata advertises S256", asMeta.code_challenge_methods_supported?.includes("S256"), asMeta);
check("AS metadata has registration_endpoint", !!asMeta.registration_endpoint, asMeta);

// 3. Dynamic client registration
const evil = await fetch(asMeta.registration_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ client_name: "evil", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }),
});
check("DCR rejects foreign redirect_uri", evil.status === 400, evil.status);

const reg = await fetch(asMeta.registration_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_name: "Claude (e2e)",
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }),
});
const client = await reg.json();
check("DCR registers public client", reg.status === 201 && !!client.client_id && !client.client_secret, client);

// 4. Authorization request with PKCE
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(8).toString("hex");
const authUrl = new URL(asMeta.authorization_endpoint);
Object.entries({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: REDIRECT,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state,
  scope: "anytype",
  resource: prm.resource,
}).forEach(([k, v]) => authUrl.searchParams.set(k, v));
const page = await fetch(authUrl);
const html = await page.text();
const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
check("authorize renders consent page", page.status === 200 && !!requestId, page.status);
check("consent page shows redirect host", html.includes("claude.ai"));

// 5. Consent
const wrong = await fetch(`${base}/oauth/consent`, form({ request_id: requestId!, password: "wrong-password!", action: "approve" }));
check("wrong password -> 401", wrong.status === 401, wrong.status);

const approved = await fetch(`${base}/oauth/consent`, form({ request_id: requestId!, password, action: "approve" }));
const location = new URL(approved.headers.get("location") ?? "about:blank");
const code = location.searchParams.get("code");
check("approve redirects to Claude with code", approved.status === 302 && location.origin === "https://claude.ai" && !!code, location.href);
check("state is preserved", location.searchParams.get("state") === state);

// 6. Token exchange
const badPkce = await fetch(asMeta.token_endpoint, form({ grant_type: "authorization_code", client_id: client.client_id, code: code!, code_verifier: "x".repeat(43), redirect_uri: REDIRECT }));
check("wrong code_verifier rejected", badPkce.status === 400, await badPkce.text());

const tokRes = await fetch(asMeta.token_endpoint, form({ grant_type: "authorization_code", client_id: client.client_id, code: code!, code_verifier: verifier, redirect_uri: REDIRECT, resource: prm.resource }));
const tokens = await tokRes.json();
check("code exchanged for tokens", tokRes.status === 200 && !!tokens.access_token && !!tokens.refresh_token, tokens);

const replay = await fetch(asMeta.token_endpoint, form({ grant_type: "authorization_code", client_id: client.client_id, code: code!, code_verifier: verifier, redirect_uri: REDIRECT }));
check("authorization code is single-use", replay.status === 400, replay.status);

// 7. MCP call with the access token
const mcp = new Client({ name: "oauth-e2e", version: "0.0.0" });
await mcp.connect(
  new StreamableHTTPClientTransport(new URL(prm.resource), {
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  }),
);
const res = await mcp.callTool({ name: "anytype_list_spaces", arguments: {} });
check("authenticated tool call works", !res.isError, res.content);
await mcp.close();

const tampered = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tokens.access_token}x` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
check("tampered token -> 401", tampered.status === 401, tampered.status);

// 8. Refresh rotation and reuse detection
const r1 = await fetch(asMeta.token_endpoint, form({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token }));
const t2 = await r1.json();
check("refresh returns new tokens", r1.status === 200 && t2.refresh_token && t2.refresh_token !== tokens.refresh_token, t2);

const reuse = await fetch(asMeta.token_endpoint, form({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token }));
const reuseBody = await reuse.json();
check("reused refresh token -> invalid_grant", reuse.status === 400 && reuseBody.error === "invalid_grant", reuseBody);

const afterReuse = await fetch(asMeta.token_endpoint, form({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: t2.refresh_token }));
check("reuse revokes the whole token family", afterReuse.status === 400, afterReuse.status);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
