// MCP tools end to end through the real MCP stack (createApp, auth disabled) against a fake Anytype API.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Client } from "@modelcontextprotocol/client";
import { createApp } from "../src/app.js";
import { fakeAnytype, mcpClient, type FakeReply, type RecordedRequest, resultText, serve, testConfig } from "./helpers.js";

let reply: (req: RecordedRequest) => FakeReply | undefined = () => undefined;
let anytype: Awaited<ReturnType<typeof fakeAnytype>>;
let server: Awaited<ReturnType<typeof serve>>;
let client: Client;

before(async () => {
  anytype = await fakeAnytype((req) => reply(req));
  const config = testConfig({ AUTH_DISABLED: "true", ANYTYPE_API_URL: anytype.url });
  server = await serve(createApp(config, { log: () => {} }).app);
  client = await mcpClient(`${server.url}/mcp`);
});

after(async () => {
  await client.close();
  await server.close();
  await anytype.close();
});

beforeEach(() => {
  anytype.requests.length = 0;
  reply = () => undefined;
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  return { isError: Boolean(res.isError), text: resultText(res) };
}

describe("tool list", () => {
  test("every tool has a title and read-only/destructive hints (directory requirement)", async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 11);
    for (const tool of tools) {
      assert.ok(tool.title ?? tool.annotations?.title, `${tool.name} has a title`);
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} readOnlyHint`);
      assert.equal(typeof tool.annotations?.destructiveHint, "boolean", `${tool.name} destructiveHint`);
    }
    const writers = tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name).sort();
    assert.deepEqual(writers, ["anytype_create_object", "anytype_delete_object", "anytype_edit_object"]);
  });
});

describe("requests sent to Anytype", () => {
  test("list_spaces passes paging and the API key", async () => {
    reply = () => ({ body: { data: [{ id: "s1", name: "Space" }] } });
    const res = await call("anytype_list_spaces", { limit: 5, offset: 10 });
    assert.equal(res.isError, false);
    assert.deepEqual(JSON.parse(res.text), { data: [{ id: "s1", name: "Space" }] });
    const [req] = anytype.requests;
    assert.equal(req?.method, "GET");
    assert.equal(req?.path, "/v2/spaces");
    assert.deepEqual(req?.query, { limit: "5", offset: "10" });
    assert.equal(req?.headers.authorization, "Bearer test-key");
  });

  test("search in a space: body without space_id/paging, ids are path-encoded", async () => {
    await call("anytype_search", { space_id: "sp/1", query: "q3", filter: "done = false", limit: 2 });
    const [req] = anytype.requests;
    assert.equal(req?.method, "POST");
    assert.equal(req?.path, "/v2/spaces/sp%2F1/search");
    assert.deepEqual(req?.body, { query: "q3", filter: "done = false" });
    assert.deepEqual(req?.query, { limit: "2" });
  });

  test("search without space_id is global", async () => {
    await call("anytype_search", { query: "x" });
    assert.equal(anytype.requests[0]?.path, "/v2/search");
  });

  test("fetch markdown merges the markdown and properties reads", async () => {
    reply = (req) =>
      req.query.format === "md"
        ? { body: { markdown: "# Body", type: "page" }, headers: { ETag: '"e7"' } }
        : { body: { properties: [{ key: "status" }] } };
    const res = await call("anytype_fetch", { space_id: "s", object_id: "o" });
    assert.deepEqual(JSON.parse(res.text), {
      id: "o",
      type: "page",
      etag: '"e7"',
      properties: [{ key: "status" }],
      markdown: "# Body",
    });
    const queries = anytype.requests.map((r) => r.query).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(queries, [{ format: "md" }, { include: "properties" }]);
    assert.ok(anytype.requests.every((r) => r.path === "/v2/spaces/s/objects/o"));
  });

  test("fetch outline returns the etag header", async () => {
    reply = () => ({ body: { blocks: [] }, headers: { ETag: '"e9"' } });
    const res = await call("anytype_fetch", { space_id: "s", object_id: "o", format: "outline" });
    assert.deepEqual(JSON.parse(res.text), { etag: '"e9"', blocks: [] });
    assert.deepEqual(anytype.requests[0]?.query, { outline: "true" });
  });

  test("fetch blocks can select a subtree", async () => {
    await call("anytype_fetch", { space_id: "s", object_id: "o", format: "blocks", block: "b1" });
    assert.deepEqual(anytype.requests[0]?.query, { block: "b1" });
  });

  test("create sends options as query and the rest as body", async () => {
    await call("anytype_create_object", {
      space_id: "s",
      type: "page",
      name: "N",
      markdown: "text",
      create_missing_options: true,
    });
    const [req] = anytype.requests;
    assert.equal(req?.method, "POST");
    assert.equal(req?.path, "/v2/spaces/s/objects");
    assert.deepEqual(req?.body, { type: "page", name: "N", markdown: "text" });
    assert.deepEqual(req?.query, { create_missing_options: "true" });
  });

  test("edit quotes a bare if_match and keeps a quoted one", async () => {
    const ops = [{ op: "replace_text", find: "a", replace: "b" }];
    await call("anytype_edit_object", { space_id: "s", object_id: "o", ops, if_match: "abc", dry_run: true });
    await call("anytype_edit_object", { space_id: "s", object_id: "o", ops, if_match: '"abc"' });
    const [first, second] = anytype.requests;
    assert.equal(first?.method, "PATCH");
    assert.equal(first?.headers["if-match"], '"abc"');
    assert.deepEqual(first?.query, { dry_run: "true" });
    assert.deepEqual(first?.body, { ops });
    assert.equal(second?.headers["if-match"], '"abc"');
  });

  test("edit without if_match sends no If-Match header", async () => {
    await call("anytype_edit_object", { space_id: "s", object_id: "o", ops: [{ op: "set_type", type: "task" }] });
    assert.equal(anytype.requests[0]?.headers["if-match"], undefined);
  });

  test("delete passes dry_run", async () => {
    await call("anytype_delete_object", { space_id: "s", object_id: "o", dry_run: true });
    const [req] = anytype.requests;
    assert.equal(req?.method, "DELETE");
    assert.equal(req?.path, "/v2/spaces/s/objects/o");
    assert.deepEqual(req?.query, { dry_run: "true" });
  });
});

describe("errors", () => {
  test("Anytype API errors are returned verbatim as tool errors", async () => {
    reply = () => ({ status: 412, body: { code: "precondition_failed", message: "etag mismatch: object changed" } });
    const res = await call("anytype_edit_object", {
      space_id: "s",
      object_id: "o",
      ops: [{ op: "delete_block", match: "x" }],
      if_match: "old",
    });
    assert.equal(res.isError, true);
    assert.match(res.text, /^Anytype API 412: etag mismatch: object changed/);
    assert.match(res.text, /precondition_failed/);
  });

  test("unknown edit ops are rejected before reaching Anytype", async () => {
    const res = await call("anytype_edit_object", { space_id: "s", object_id: "o", ops: [{ op: "drop_table" }] });
    assert.equal(res.isError, true);
    assert.equal(anytype.requests.length, 0);
  });

  test("an unreachable Anytype is reported, not thrown", async () => {
    const config = testConfig({ AUTH_DISABLED: "true", ANYTYPE_API_URL: "http://127.0.0.1:9" });
    const app = await serve(createApp(config, { log: () => {} }).app);
    const c = await mcpClient(`${app.url}/mcp`);
    try {
      const res = await c.callTool({ name: "anytype_list_spaces", arguments: {} });
      assert.equal(res.isError, true);
      assert.match(resultText(res), /^Error: /);
    } finally {
      await c.close();
      await app.close();
    }
  });
});
