// Client ID Metadata Document resolver: URL policy, SSRF guard, document validation, limits, cache.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CimdResolver, isCimdClientId, isPublicAddress } from "../src/auth/cimd.js";

const ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const DOC = { client_id: ID, client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] };

/** Resolver with a fake fetch that serves `body` (or a Response factory) and counts calls. */
function resolver(body: unknown = DOC, { hosts = ["claude.ai"], addresses = ["160.79.104.10"] } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return typeof body === "function" ? (body as () => Response)() : Response.json(body);
  }) as typeof fetch;
  const r = new CimdResolver(hosts, fetchImpl, async (host) => {
    for (const a of addresses) if (!isPublicAddress(a)) throw new Error(`${host} resolves to a non-public address`);
    return addresses;
  });
  return { r, calls };
}

describe("isCimdClientId", () => {
  test("only https URLs are metadata documents", () => {
    assert.ok(isCimdClientId(ID));
    assert.ok(!isCimdClientId("http://claude.ai/x"));
    assert.ok(!isCimdClientId("3f1c2a8e-uuid"));
  });
});

describe("isPublicAddress", () => {
  const cases: [string, boolean][] = [
    ["160.79.104.10", true],
    ["8.8.8.8", true],
    ["127.0.0.1", false],
    ["10.1.2.3", false],
    ["172.16.0.1", false],
    ["172.31.250.1", false],
    ["172.32.0.1", true],
    ["192.168.1.1", false],
    ["169.254.169.254", false], // cloud metadata
    ["100.64.0.1", false], // CGNAT
    ["0.0.0.0", false],
    ["224.0.0.1", false],
    ["2606:4700::1111", true],
    ["::1", false],
    ["::", false],
    ["fd00::1", false],
    ["fe80::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:8.8.8.8", true],
    ["::127.0.0.1", false], // IPv4-compatible
    ["::ffff:7f00:1", false], // mapped, hex form
    ["64:ff9b::a00:1", false], // NAT64
    ["2002:a00:1::1", false], // 6to4
    ["2001:0:4136:e378::1", false], // Teredo
    ["2001:db8::1", false],
    ["fec0::1", false],
    ["100::1", false],
    ["not an ip", false],
  ];
  for (const [address, expected] of cases) {
    test(`${address} -> ${expected ? "public" : "blocked"}`, () => assert.equal(isPublicAddress(address), expected));
  }
});

describe("CimdResolver", () => {
  test("fetches a valid document without following redirects", async () => {
    const { r, calls } = resolver();
    const doc = await r.resolve(ID);
    assert.equal(doc.client_name, "Claude");
    assert.equal(doc.token_endpoint_auth_method, "none");
    assert.equal(calls[0]?.init?.redirect, "manual");
  });

  test("URL policy", async () => {
    const { r, calls } = resolver();
    const bad: [string, RegExp][] = [
      ["https://evil.example.test/client", /not trusted/],
      ["https://claude.ai/", /must have a path/],
      ["https://claude.ai:8443/x", /default https port/],
      ["https://user:pw@claude.ai/x", /credentials/],
      ["https://claude.ai/x#frag", /fragment/],
      ["https://160.79.104.10/x", /not an IP/],
      ["http://claude.ai/x", /https/],
    ];
    for (const [id, message] of bad) await assert.rejects(r.resolve(id), message, id);
    assert.equal(calls.length, 0, "nothing was fetched");
  });

  test("hosts resolving to private addresses are refused", async () => {
    const { r, calls } = resolver(DOC, { addresses: ["160.79.104.10", "10.0.0.5"] });
    await assert.rejects(r.resolve(ID), /non-public/);
    assert.equal(calls.length, 0);
  });

  test('"*" trusts any public host', async () => {
    const id = "https://app.example.test/client.json";
    const { r } = resolver({ ...DOC, client_id: id }, { hosts: ["*"] });
    assert.equal((await r.resolve(id)).client_id, id);
  });

  test("document validation", async () => {
    const bad: [unknown, RegExp][] = [
      [{ ...DOC, client_id: "https://claude.ai/other" }, /does not match/],
      [{ ...DOC, client_name: " " }, /client_name/],
      [{ ...DOC, redirect_uris: [] }, /redirect_uris/],
      [{ ...DOC, redirect_uris: ["not a url"] }, /redirect_uris/],
      [{ ...DOC, token_endpoint_auth_method: "client_secret_basic" }, /public clients/],
      [{ ...DOC, client_secret: "s" }, /client_secret/],
      [[DOC], /not a JSON object/],
    ];
    for (const [body, message] of bad) await assert.rejects(resolver(body).r.resolve(ID), message);
  });

  test("non-200 answers, redirects, invalid JSON and oversized documents are refused", async () => {
    const answers: [() => Response, RegExp][] = [
      [() => new Response("", { status: 302, headers: { Location: "https://evil.example.test/" } }), /answered 302/],
      [() => new Response("nope", { status: 404 }), /answered 404/],
      [() => new Response("{not json"), /not valid JSON/],
      [() => new Response(JSON.stringify({ ...DOC, pad: "x".repeat(70_000) })), /too large/],
    ];
    for (const [answer, message] of answers) await assert.rejects(resolver(answer).r.resolve(ID), message);
  });

  test("failures are cached briefly, so retries don't refetch", async () => {
    const { r, calls } = resolver(() => new Response("nope", { status: 404 }));
    await assert.rejects(r.resolve(ID), /answered 404/);
    await assert.rejects(r.resolve(ID), /answered 404/);
    assert.equal(calls.length, 1);
  });

  test("documents are cached", async () => {
    const { r, calls } = resolver(() => Response.json(DOC, { headers: { "Cache-Control": "max-age=600" } }));
    await r.resolve(ID);
    await r.resolve(ID);
    assert.equal(calls.length, 1);
  });
});
