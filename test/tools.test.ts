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
    assert.equal(tools.length, 23);
    for (const tool of tools) {
      assert.ok(tool.title ?? tool.annotations?.title, `${tool.name} has a title`);
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} readOnlyHint`);
      assert.equal(typeof tool.annotations?.destructiveHint, "boolean", `${tool.name} destructiveHint`);
    }
    const writers = tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name).sort();
    assert.deepEqual(writers, [
      "anytype_add_comment",
      "anytype_create_collection",
      "anytype_create_object",
      "anytype_create_query",
      "anytype_delete_object",
      "anytype_edit_object",
      "anytype_send_chat_message",
    ]);
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort();
    assert.deepEqual(destructive, ["anytype_delete_object", "anytype_edit_object"]);
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
    assert.match(res.text, /^Anytype API 412: etag mismatch: object changed \(precondition_failed\)/);
    assert.match(res.text, /fetch it again/);
  });

  test("issues are rendered with the matching tool call", async () => {
    reply = () => ({
      status: 400,
      body: {
        status: 400,
        code: "validation_failed",
        message: "set_properties rejected",
        issues: [
          {
            path: "ops[0].set.nonexistent_prop",
            message: 'unknown property key "nonexistent_prop"',
            hint: "list all with GET /v2/spaces/sp/properties, or create it with POST /v2/spaces/sp/properties",
            see_also: [
              { op: "list_properties", params: { space_id: "sp" } },
              { op: "create_property", params: { space_id: "sp" } },
            ],
          },
          {
            path: "ops[1].find",
            message: "the find text must appear in exactly one block",
            see_also: [
              { op: "get_object" },
              { op: "get_object", query: { outline: "true" } },
              { query: { create_missing_options: "true" } },
            ],
          },
        ],
      },
    });
    const res = await call("anytype_edit_object", { space_id: "sp", object_id: "o", ops: [{ op: "set_properties" }] });
    assert.equal(res.isError, true);
    assert.equal(
      res.text,
      [
        "Anytype API 400: set_properties rejected (validation_failed)",
        '- ops[0].set.nonexistent_prop: unknown property key "nonexistent_prop"',
        "  hint: list all with GET /v2/spaces/sp/properties, or create it with POST /v2/spaces/sp/properties",
        '  next: anytype_list_properties {"space_id":"sp"} | create_property (not available as a tool)',
        "- ops[1].find: the find text must appear in exactly one block",
        '  next: anytype_fetch | anytype_fetch {"format":"outline"} | retry the same call with create_missing_options: true',
      ].join("\n"),
    );
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

describe("output shaping", () => {
  test("results are compact JSON with next_offset when more pages exist", async () => {
    reply = () => ({ body: { data: [{ id: "a" }, { id: "b" }], total: 5, offset: 2, limit: 2, has_more: true } });
    const res = await call("anytype_search", { query: "x", offset: 2, limit: 2 });
    assert.ok(!res.text.includes("\n"), "no pretty-printing");
    assert.equal(JSON.parse(res.text).next_offset, 4);
  });

  test("warnings are rendered after the JSON with tool hints", async () => {
    reply = () => ({
      body: {
        id: "q1",
        warnings: [{ path: "/filter", message: "the query has no filter", see_also: [{ op: "get_schema", params: { kind: "filters" } }] }],
      },
    });
    const res = await call("anytype_create_query", { space_id: "s", name: "All tasks", type: "task" });
    const [json, ...rest] = res.text.split("\n");
    assert.deepEqual(JSON.parse(json!), { id: "q1" });
    assert.deepEqual(rest, ["warnings:", "- /filter: the query has no filter", '  next: anytype_get_schema {"kind":"filters"}']);
  });

  test("long markdown is paged by characters", async () => {
    const body = "x".repeat(2500);
    reply = (req) => (req.query.format === "md" ? { body: { markdown: body, type: "page" } } : { body: {} });
    const first = JSON.parse((await call("anytype_fetch", { space_id: "s", object_id: "o", max_chars: 1000 })).text);
    assert.equal(first.markdown.length, 1000);
    assert.deepEqual(first.truncated, { start: 0, end: 1000, total_chars: 2500, next_start: 1000 });
    const last = JSON.parse((await call("anytype_fetch", { space_id: "s", object_id: "o", max_chars: 1000, start: 2000 })).text);
    assert.equal(last.markdown.length, 500);
    assert.deepEqual(last.truncated, { start: 2000, end: 2500, total_chars: 2500 });
  });

  test("short markdown is not marked as truncated; comments are flagged", async () => {
    reply = (req) => (req.query.format === "md" ? { body: { markdown: "hi", type: "page" } } : { body: { discussion: "c1" } });
    const res = JSON.parse((await call("anytype_fetch", { space_id: "s", object_id: "o" })).text);
    assert.equal(res.truncated, undefined);
    assert.equal(res.has_comments, true);
  });
});

describe("collections and queries", () => {
  test("list_items reads a collection directly", async () => {
    reply = () => ({ body: { data: [{ id: "x" }], has_more: false } });
    await call("anytype_list_items", { space_id: "s", list_id: "c1", fields: ["status", "due_date"], view: "v1" });
    assert.equal(anytype.requests.length, 1);
    assert.equal(anytype.requests[0]?.path, "/v2/spaces/s/collections/c1/objects");
    assert.deepEqual(anytype.requests[0]?.query, { view: "v1", fields: "status,due_date" });
  });

  test("list_views falls back to the query endpoint when the id is a query", async () => {
    reply = (req) =>
      req.path.includes("/collections/")
        ? {
            status: 400,
            body: {
              code: "validation_failed",
              message: 'object "q1" is a query, not a collection',
              issues: [
                { message: "queries are read through their own operation", see_also: [{ op: "get_query_objects", params: { query_id: "q1" } }] },
              ],
            },
          }
        : { body: { data: [{ id: "row" }], has_more: false } };
    const res = await call("anytype_list_views", { space_id: "s", list_id: "q1" });
    assert.equal(res.isError, false);
    assert.deepEqual(
      anytype.requests.map((r) => r.path),
      ["/v2/spaces/s/collections/q1/views", "/v2/spaces/s/queries/q1/views"],
    );
  });

  test("an id that is neither is reported, not retried", async () => {
    reply = () => ({
      status: 400,
      body: {
        code: "validation_failed",
        message: 'object "p" is neither a query nor a collection',
        issues: [
          { message: "only queries and collections list objects", see_also: [{ op: "get_query_objects" }, { op: "get_collection_objects" }] },
        ],
      },
    });
    const res = await call("anytype_list_items", { space_id: "s", list_id: "p" });
    assert.equal(res.isError, true);
    assert.equal(anytype.requests.length, 1);
    assert.match(res.text, /next: anytype_list_items/);
  });

  test("create_collection and create_query send options as query", async () => {
    await call("anytype_create_collection", { space_id: "s", name: "Reading list", items: ["a"], dry_run: true });
    await call("anytype_create_query", { space_id: "s", name: "Open", type: "task", filter: "done = false", create_missing_options: true });
    const [col, q] = anytype.requests;
    assert.equal(col?.path, "/v2/spaces/s/collections");
    assert.deepEqual(col?.body, { name: "Reading list", items: ["a"] });
    assert.deepEqual(col?.query, { dry_run: "true" });
    assert.equal(q?.path, "/v2/spaces/s/queries");
    assert.deepEqual(q?.body, { name: "Open", type: "task", filter: "done = false" });
    assert.deepEqual(q?.query, { create_missing_options: "true" });
  });
});

describe("comments and chats", () => {
  const messages = {
    messages: [
      {
        id: "m1",
        at: "2026-10-08T10:00:00Z",
        author: "Alice",
        author_id: "p-1",
        order: "!!",
        text: "",
        blocks_text: "first",
        reacted_by: { "👍": ["p-2"] },
        reactions: { "👍": 1 },
      },
      { id: "m2", at: "2026-10-08T10:01:00Z", author: "Bot", author_id: "p-2", order: "!#", text: "second", reply_to: "m1", reactions: {} },
    ],
    has_more: true,
    next_before: "!!",
    message_count: 7,
    state: { unread: 0 },
  };

  test("list_comments finds the discussion and returns compact messages", async () => {
    reply = (req) => (req.path.endsWith("/objects/o") ? { body: { id: "o", discussion: "d1" } } : { body: messages });
    const res = JSON.parse((await call("anytype_list_comments", { space_id: "s", object_id: "o", limit: 2 })).text);
    assert.equal(anytype.requests[1]?.path, "/v2/spaces/s/chats/d1/messages");
    assert.deepEqual(anytype.requests[1]?.query, { limit: "2" });
    assert.equal(res.chat_id, "d1");
    assert.deepEqual(res.messages, [
      { id: "m1", at: "2026-10-08T10:00:00Z", author: "Alice", text: "first", reactions: { "👍": 1 } },
      { id: "m2", at: "2026-10-08T10:01:00Z", author: "Bot", text: "second", reply_to: "m1" },
    ]);
    assert.equal(res.next_before, "!!");
    assert.equal(res.state, undefined);
  });

  test("an object without a discussion has no comments (and none is created)", async () => {
    reply = () => ({ body: { id: "o" } });
    const res = JSON.parse((await call("anytype_list_comments", { space_id: "s", object_id: "o" })).text);
    assert.deepEqual(res, { messages: [], message_count: 0 });
    assert.equal(anytype.requests.length, 1);
  });

  test("add_comment opens the discussion, then posts", async () => {
    reply = (req) => (req.path.endsWith("/discussion") ? { body: { id: "d1", created: true } } : { body: { id: "m9" } });
    const res = JSON.parse((await call("anytype_add_comment", { space_id: "s", object_id: "o", text: "Looks good", reply_to: "m1" })).text);
    assert.deepEqual(
      anytype.requests.map((r) => `${r.method} ${r.path}`),
      ["POST /v2/spaces/s/objects/o/discussion", "POST /v2/spaces/s/chats/d1/messages"],
    );
    assert.deepEqual(anytype.requests[1]?.body, { text: "Looks good", reply_to: "m1" });
    assert.deepEqual(res, { chat_id: "d1", id: "m9" });
  });

  test("read_chat pages with cursors; send_chat_message posts the body", async () => {
    reply = () => ({ body: messages });
    await call("anytype_read_chat", { space_id: "s", chat_id: "c", before: "!#" });
    assert.deepEqual(anytype.requests[0]?.query, { before: "!#" });
    await call("anytype_send_chat_message", { space_id: "s", chat_id: "c", text: "hi", attachments: ["o1"] });
    assert.deepEqual(anytype.requests[1]?.body, { text: "hi", attachments: ["o1"] });
  });
});
