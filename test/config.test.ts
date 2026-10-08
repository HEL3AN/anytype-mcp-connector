import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";

const base = { API_KEY: "k", OWNER_PASSWORD: "twelve chars!" };

describe("loadConfig", () => {
  test("defaults", () => {
    const c = loadConfig(base);
    assert.equal(c.host, "127.0.0.1");
    assert.equal(c.port, 3000);
    assert.equal(c.mcpUrl.href, "http://localhost:3000/mcp");
    assert.equal(c.anytypeUrl, "http://127.0.0.1:31009");
    assert.equal(c.trustProxy, "loopback");
    assert.deepEqual(c.auth.cimdTrustedHosts, ["claude.ai", "claude.com"]);
    assert.equal(c.auth.disabled, false);
  });

  test("required settings", () => {
    assert.throws(() => loadConfig({ OWNER_PASSWORD: "twelve chars!" }), /API_KEY/);
    assert.throws(() => loadConfig({ API_KEY: "k" }), /OWNER_PASSWORD/);
    assert.throws(() => loadConfig({ ...base, OWNER_PASSWORD: "short" }), /at least 12/);
    assert.equal(loadConfig({ ANYTYPE_API_KEY: " key ", OWNER_PASSWORD: "twelve chars!" }).anytypeApiKey, "key");
  });

  test("auth can only be disabled on loopback", () => {
    assert.equal(loadConfig({ API_KEY: "k", AUTH_DISABLED: "true" }).auth.disabled, true);
    assert.throws(() => loadConfig({ API_KEY: "k", AUTH_DISABLED: "true", HOST: "0.0.0.0" }), /loopback/);
  });

  test("public URL must be https unless it is localhost", () => {
    assert.throws(() => loadConfig({ ...base, PUBLIC_URL: "http://mcp.example.test" }), /https/);
    const c = loadConfig({ ...base, PUBLIC_URL: "https://mcp.example.test", ALLOWED_HOSTS: "a.test, b.test" });
    assert.equal(c.mcpUrl.href, "https://mcp.example.test/mcp");
    assert.deepEqual(c.allowedHosts, ["mcp.example.test", "a.test", "b.test"]);
  });

  test("trust proxy parsing", () => {
    assert.equal(loadConfig({ ...base, TRUST_PROXY: "1" }).trustProxy, 1);
    assert.equal(loadConfig({ ...base, TRUST_PROXY: "false" }).trustProxy, false);
    assert.equal(loadConfig({ ...base, TRUST_PROXY: "10.0.0.0/8" }).trustProxy, "10.0.0.0/8");
  });

  test("lists: CIMD hosts are lower-cased, extra redirect URIs appended", () => {
    const c = loadConfig({ ...base, CIMD_TRUSTED_HOSTS: "Claude.AI, ,example.test", EXTRA_REDIRECT_URIS: "https://x.test/cb" });
    assert.deepEqual(c.auth.cimdTrustedHosts, ["claude.ai", "example.test"]);
    assert.equal(c.auth.allowedRedirectUris.at(-1), "https://x.test/cb");
  });

  test("trailing slashes are stripped from the Anytype URL", () => {
    assert.equal(loadConfig({ ...base, ANYTYPE_API_URL: "http://anytype:31012//" }).anytypeUrl, "http://anytype:31012");
  });
});
