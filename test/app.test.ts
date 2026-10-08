// HTTP surface of the app: Host validation, health checks, landing page, robots, auth challenge, logging.
import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, test } from "node:test";
import { createApp } from "../src/app.js";
import { fakeAnytype, serve, tempDir, testConfig } from "./helpers.js";

let keyValid = true;
const logLines: string[] = [];
const data = tempDir();
let anytype: Awaited<ReturnType<typeof fakeAnytype>>;
let server: Awaited<ReturnType<typeof serve>>;

before(async () => {
  anytype = await fakeAnytype((req) =>
    req.path === "/v2/auth/whoami"
      ? keyValid
        ? { body: { key_status: "scoped", grant: { all_spaces: false, spaces: [{ id: "a" }, { id: "b" }] } } }
        : { status: 401, body: { message: "invalid api key" } }
      : undefined,
  );
  const config = testConfig({
    ANYTYPE_API_URL: anytype.url,
    DATA_DIR: data.dir,
    PUBLIC_URL: "https://mcp.example.test",
    GOOGLE_SITE_VERIFICATION: "verify-token",
  });
  server = await serve(createApp(config, { log: (line) => logLines.push(line) }).app);
});

after(async () => {
  await server.close();
  await anytype.close();
  data.cleanup();
});

/** Raw request, so the Host header can be set freely. */
function get(path: string, host: string) {
  const url = new URL(path, server.url);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, { headers: { Host: host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("Host validation (DNS rebinding)", () => {
  test("the public host and loopback are accepted", async () => {
    assert.equal((await get("/healthz", "mcp.example.test")).status, 200);
    assert.equal((await get("/healthz", "localhost:3000")).status, 200);
    assert.equal((await get("/healthz", "[::1]:3000")).status, 200);
  });

  test("other hosts are refused", async () => {
    const res = await get("/healthz", "attacker.example.test");
    assert.equal(res.status, 403);
    assert.match(res.body, /Invalid Host/);
  });
});

describe("health", () => {
  test("/healthz reports the version", async () => {
    const body = (await (await fetch(`${server.url}/healthz`)).json()) as { ok: boolean; version: string };
    assert.equal(body.ok, true);
    assert.match(body.version, /^\d+\.\d+\.\d+/);
  });

  test("/readyz reflects the Anytype API key", async () => {
    keyValid = true;
    const ok = await fetch(`${server.url}/readyz`);
    assert.equal(ok.status, 200);
    assert.deepEqual(((await ok.json()) as { anytype: unknown }).anytype, { key_status: "scoped", spaces: 2 });

    keyValid = false;
    const down = await fetch(`${server.url}/readyz`);
    assert.equal(down.status, 503);
    assert.match(((await down.json()) as { error: string }).error, /401: invalid api key/);
  });
});

describe("public pages", () => {
  test("landing page links the MCP URL and the icon, with Search Console verification", async () => {
    const res = await fetch(`${server.url}/`);
    const html = await res.text();
    assert.match(html, /https:\/\/mcp\.example\.test\/mcp/);
    assert.match(html, /rel="icon"/);
    assert.match(
      html,
      /href="https:\/\/claude\.ai\/customize\/connectors\?modal=add-custom-connector&amp;connectorName=Anytype&amp;connectorUrl=https%3A%2F%2Fmcp\.example\.test%2Fmcp"/,
    );
    assert.match(html, /name="google-site-verification" content="verify-token"/);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  });

  test("icons are served", async () => {
    for (const path of ["/favicon.ico", "/icon.svg", "/icon-128.png"]) {
      assert.equal((await fetch(server.url + path)).status, 200, path);
    }
  });

  test("robots.txt allows only the home page and icons", async () => {
    const text = await (await fetch(`${server.url}/robots.txt`)).text();
    assert.match(text, /Allow: \/\$/);
    assert.match(text, /Disallow: \//);
  });
});

describe("MCP endpoint with OAuth enabled", () => {
  test("requests without a token get a 401 challenge pointing at the resource metadata", async () => {
    const res = await fetch(`${server.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  });
});

describe("Origin check on /mcp", () => {
  const post = (origin?: string) =>
    fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: "{}",
    });

  test("a foreign browser Origin is refused before authentication", async () => {
    const res = await post("https://evil.example.test");
    assert.equal(res.status, 403);
    assert.match(await res.text(), /Origin not allowed/);
  });

  test("no Origin, the server's own and Claude's origins reach the auth check", async () => {
    for (const origin of [undefined, "https://mcp.example.test", "https://claude.ai", "http://localhost:6274"]) {
      assert.equal((await post(origin)).status, 401, String(origin));
    }
  });
});

describe("request log", () => {
  test("logs method, path and status, never query strings", async () => {
    logLines.length = 0;
    await fetch(`${server.url}/authorize?client_id=x&code_challenge=secret-value`);
    assert.equal(logLines.length, 1);
    assert.match(logLines[0]!, /^GET \/authorize 400 \d+ms$/);
    assert.doesNotMatch(logLines.join("\n"), /secret-value/);
  });
});
