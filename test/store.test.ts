import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { AuthStore } from "../src/auth/store.js";
import { tempDir } from "./helpers.js";

const now = () => Math.floor(Date.now() / 1000);
const client = (id: string, issuedAt: number) => ({
  client_id: id,
  client_id_issued_at: issuedAt,
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code"],
  response_types: ["code"],
});

describe("AuthStore", () => {
  test("DCR clients that never got a token are dropped after a day; active ones stay", () => {
    const { dir, cleanup } = tempDir();
    try {
      const store = new AuthStore(dir);
      store.saveRefreshToken("h1", { clientId: "active", scopes: [], resource: "r", family: "f", expiresAt: now() + 3600 });
      store.saveClient(client("active", now() - 2 * 86400));
      store.saveClient(client("fresh", now()));
      store.saveClient(client("stale", now() - 2 * 86400));
      assert.ok(store.getClient("fresh"));
      assert.ok(store.getClient("active"));
      assert.equal(store.getClient("stale"), undefined);
    } finally {
      cleanup();
    }
  });

  test("revoked families expire; old state files without the new fields still load", () => {
    const { dir, cleanup } = tempDir();
    try {
      writeFileSync(path.join(dir, "oauth.json"), JSON.stringify({ clients: {}, refreshTokens: {}, rotatedTokens: {} }));
      const store = new AuthStore(dir);
      store.revokeFamily("gone", now() - 1);
      store.revokeFamily("live", now() + 60);
      assert.equal(store.isFamilyRevoked("gone"), false);
      assert.equal(store.isFamilyRevoked("live"), true);
      const saved = JSON.parse(readFileSync(path.join(dir, "oauth.json"), "utf8"));
      assert.deepEqual(Object.keys(saved.revokedFamilies), ["live"]);
    } finally {
      cleanup();
    }
  });
});
