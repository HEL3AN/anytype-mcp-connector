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
    assert.equal(tools.length, 37);
    for (const tool of tools) {
      assert.ok(tool.title ?? tool.annotations?.title, `${tool.name} has a title`);
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} readOnlyHint`);
      assert.equal(typeof tool.annotations?.destructiveHint, "boolean", `${tool.name} destructiveHint`);
    }
    const writers = tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name).sort();
    assert.deepEqual(writers, [
      "anytype_add_comment",
      "anytype_create_chat",
      "anytype_create_collection",
      "anytype_create_object",
      "anytype_create_property",
      "anytype_create_query",
      "anytype_create_type",
      "anytype_delete_chat_message",
      "anytype_delete_object",
      "anytype_edit_chat_message",
      "anytype_edit_object",
      "anytype_react_to_message",
      "anytype_send_chat_message",
      "anytype_update_property",
      "anytype_update_space",
      "anytype_update_type",
      "anytype_upload_file",
    ]);
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort();
    assert.deepEqual(destructive, [
      "anytype_delete_chat_message",
      "anytype_delete_object",
      "anytype_edit_chat_message",
      "anytype_edit_object",
      "anytype_update_property",
      "anytype_update_space",
      "anytype_update_type",
    ]);
  });

  test("prompts are listed and render a user message", async () => {
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), ["meeting_to_tasks", "topic_brief", "weekly_review"]);
    const res = await client.getPrompt({ name: "weekly_review", arguments: { space: "Work", days: "14" } });
    const text = (res.messages[0]?.content as { text: string }).text;
    assert.match(text, /space "Work"/);
    assert.match(text, /daysAgo\(14\)/);
    assert.match(text, /anytype_fetch_many/);
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
    assert.deepEqual(req?.body, { query: "q3", filter: "done = false", fields: ["snippet"] });
    assert.deepEqual(req?.query, { limit: "2" });
  });

  test("search always asks for snippets, keeping requested fields", async () => {
    await call("anytype_search", { query: "x", fields: ["status", "snippet"] });
    assert.deepEqual((anytype.requests[0]?.body as { fields: string[] }).fields, ["snippet", "status"]);
  });

  test("search without space_id is global", async () => {
    await call("anytype_search", { query: "x" });
    assert.equal(anytype.requests[0]?.path, "/v2/search");
  });

  test("fetch markdown merges the markdown, properties and backlinks reads", async () => {
    reply = (req) =>
      req.method === "POST"
        ? { body: { data: [{ id: "p1", name: "Linking page", type: "page", properties: {} }], has_more: true } }
        : req.query.format === "md"
          ? { body: { markdown: "# Body", type: "page" }, headers: { ETag: '"e7"' } }
          : { body: { properties: [{ key: "status" }] } };
    const res = await call("anytype_fetch", { space_id: "s", object_id: "o" });
    assert.deepEqual(JSON.parse(res.text), {
      id: "o",
      type: "page",
      etag: '"e7"',
      properties: [{ key: "status" }],
      backlinks: [{ id: "p1", name: "Linking page", type: "page" }],
      more_backlinks: true,
      markdown: "# Body",
    });
    const gets = anytype.requests.filter((r) => r.method === "GET");
    const queries = gets.map((r) => r.query).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(queries, [{ format: "md" }, { include: "properties" }]);
    assert.ok(gets.every((r) => r.path === "/v2/spaces/s/objects/o"));
    const search = anytype.requests.find((r) => r.method === "POST");
    assert.equal(search?.path, "/v2/spaces/s/search");
    assert.deepEqual(search?.body, { filter: 'links HAS ALL ("o")' });
    assert.deepEqual(search?.query, { limit: "20" });
  });

  test("fetch still succeeds when the backlinks search fails", async () => {
    reply = (req) =>
      req.method === "POST" ? { status: 500, body: { message: "boom" } } : { body: { markdown: "x", type: "page" } };
    const res = await call("anytype_fetch", { space_id: "s", object_id: "o" });
    assert.equal(res.isError, false);
    assert.equal(JSON.parse(res.text).backlinks, undefined);
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
        '  next: anytype_list_properties {"space_id":"sp"} | anytype_create_property {"space_id":"sp"}',
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

  test("fetch_many reads each object once, in order, sharing the character budget", async () => {
    reply = (req) => {
      const id = req.path.split("/").pop();
      if (id === "bad") return { status: 404, body: { code: "not_found", message: "object not found" } };
      return req.query.format === "md" ? { body: { markdown: `${id}:` + "y".repeat(3000), type: "page" } } : { body: {} };
    };
    const res = await call("anytype_fetch_many", { space_id: "s", object_ids: ["a", "bad", "b", "a"], max_chars: 2000 });
    assert.equal(res.isError, false);
    const { objects } = JSON.parse(res.text);
    assert.deepEqual(objects.map((o: { id: string }) => o.id), ["a", "bad", "b"]);
    assert.equal(objects[0].markdown.length, 666);
    assert.equal(objects[0].truncated.next_start, 666);
    assert.match(objects[1].error, /^Anytype API 404: object not found/);
    assert.equal(anytype.requests.filter((r) => r.method === "GET").length, 6);
  });

  test("fetch_many refuses more than 10 ids before reaching Anytype", async () => {
    const res = await call("anytype_fetch_many", { space_id: "s", object_ids: Array.from({ length: 11 }, (_, i) => `o${i}`) });
    assert.equal(res.isError, true);
    assert.equal(anytype.requests.length, 0);
  });
});

describe("schema, spaces, chats and files", () => {
  test("create_type maps key, icon and properties, and creates options only when given", async () => {
    await call("anytype_create_type", {
      space_id: "s",
      name: "Meeting",
      key: "meeting",
      icon: "📅",
      properties: [{ name: "Room", format: "text" }, { property: "status" }],
    });
    await call("anytype_create_type", { space_id: "s", name: "Mood", properties: [{ name: "Feel", format: "select", options: [{ name: "Calm" }] }] });
    const [first, second] = anytype.requests;
    assert.equal(first?.path, "/v2/spaces/s/types");
    assert.deepEqual(first?.body, {
      name: "Meeting",
      api_key: "meeting",
      icon: { format: "emoji", emoji: "📅" },
      property_definitions: [{ name: "Room", format: "text" }, { property: "status" }],
    });
    assert.deepEqual(first?.query, {});
    assert.deepEqual(second?.query, { create_missing_options: "true" });
  });

  test("a property definition needs a name or a key, not both", async () => {
    const res = await call("anytype_create_type", { space_id: "s", name: "X", properties: [{ name: "A", property: "a" }] });
    assert.equal(res.isError, true);
    assert.equal(anytype.requests.length, 0);
  });

  test("update_type sends flat fields and ops as separate requests", async () => {
    reply = () => ({ body: { key: "meeting" } });
    const res = await call("anytype_update_type", {
      space_id: "s",
      type: "meeting",
      name: "Meeting 2",
      ops: [{ op: "add_property", property: "Room", format: "text" }],
    });
    assert.deepEqual(JSON.parse(res.text), { results: [{ key: "meeting" }, { key: "meeting" }] });
    assert.deepEqual(anytype.requests.map((r) => [r.method, r.path, r.body]), [
      ["PATCH", "/v2/spaces/s/types/meeting", { name: "Meeting 2" }],
      ["PATCH", "/v2/spaces/s/types/meeting", { ops: [{ op: "add_property", property: "Room", format: "text" }] }],
    ]);
    const empty = await call("anytype_update_type", { space_id: "s", type: "meeting" });
    assert.equal(empty.isError, true);
  });

  test("properties: create and rename", async () => {
    await call("anytype_create_property", { space_id: "s", name: "Mood", format: "select", options: [{ name: "Calm" }] });
    await call("anytype_update_property", { space_id: "s", key: "mood", name: "Feeling" });
    assert.deepEqual(anytype.requests.map((r) => [r.method, r.path, r.body]), [
      ["POST", "/v2/spaces/s/properties", { name: "Mood", format: "select", options: [{ name: "Calm" }] }],
      ["PATCH", "/v2/spaces/s/properties/mood", { name: "Feeling" }],
    ]);
  });

  test("spaces: get and update", async () => {
    await call("anytype_get_space", { space_id: "s" });
    await call("anytype_update_space", { space_id: "s", description: "Work notes", dry_run: true });
    assert.deepEqual(anytype.requests.map((r) => [r.method, r.path, r.body, r.query]), [
      ["GET", "/v2/spaces/s", undefined, {}],
      ["PATCH", "/v2/spaces/s", { description: "Work notes" }, { dry_run: "true" }],
    ]);
  });

  test("chat messages: edit, react, delete; create a chat", async () => {
    await call("anytype_edit_chat_message", { space_id: "s", chat_id: "c", message_id: "m", text: "new" });
    await call("anytype_react_to_message", { space_id: "s", chat_id: "c", message_id: "m", emoji: "👍" });
    await call("anytype_delete_chat_message", { space_id: "s", chat_id: "c", message_id: "m" });
    await call("anytype_create_chat", { space_id: "s", name: "Team" });
    assert.deepEqual(anytype.requests.map((r) => [r.method, r.path, r.body]), [
      ["PATCH", "/v2/spaces/s/chats/c/messages/m", { text: "new" }],
      ["POST", "/v2/spaces/s/chats/c/messages/m/reactions", { emoji: "👍" }],
      ["DELETE", "/v2/spaces/s/chats/c/messages/m", undefined],
      ["POST", "/v2/spaces/s/chats", { name: "Team" }],
    ]);
  });

  test("upload_file passes public URLs and refuses internal ones before reaching Anytype", async () => {
    for (const url of ["http://127.0.0.1/admin", "http://10.0.0.5/x.png", "http://[::1]/", "https://user:pw@93.184.216.34/x", "ftp://93.184.216.34/x"]) {
      const res = await call("anytype_upload_file", { space_id: "s", url });
      assert.equal(res.isError, true, url);
    }
    assert.equal(anytype.requests.length, 0);
    reply = () => ({ status: 201, body: { id: "f1", name: "x.png", mime_type: "image/png", size: 10 } });
    const ok = await call("anytype_upload_file", { space_id: "s", url: "https://93.184.216.34/x.png", name: "x.png" });
    assert.equal(ok.isError, false);
    assert.deepEqual(anytype.requests[0]?.body, { url: "https://93.184.216.34/x.png", name: "x.png" });
  });

  test("get_file returns images as images, text as text, other formats as metadata", async () => {
    const files: Record<string, FakeReply> = {
      img: { headers: { "Content-Type": "image/png" }, body: "PNGDATA" },
      txt: { headers: { "Content-Type": "text/csv; charset=utf-8" }, body: "a,b" },
      pdf: { headers: { "Content-Type": "application/pdf" }, body: "%PDF" },
    };
    reply = (req) => files[req.path.split("/")[5]!];
    const img = await client.callTool({ name: "anytype_get_file", arguments: { space_id: "s", file_id: "img" } });
    const [content] = img.content as { type: string; data: string; mimeType: string }[];
    assert.equal(content?.type, "image");
    assert.equal(content?.mimeType, "image/png");
    assert.equal(Buffer.from(content!.data, "base64").toString(), JSON.stringify("PNGDATA"));
    assert.deepEqual(anytype.requests[0]?.query, { width: "1024" });
    assert.equal(anytype.requests[0]?.path, "/v2/spaces/s/files/img/content");
    const txt = JSON.parse((await call("anytype_get_file", { space_id: "s", file_id: "txt" })).text);
    assert.equal(txt.text, JSON.stringify("a,b"));
    const pdf = JSON.parse((await call("anytype_get_file", { space_id: "s", file_id: "pdf" })).text);
    assert.equal(pdf.mime_type, "application/pdf");
    assert.equal(pdf.text, undefined);
  });
});

describe("interactive card (MCP App)", () => {
  test("show_objects links its UI, reads all rows in one search and keeps the given order", async () => {
    reply = (req) => {
      if (req.method === "POST")
        return {
          body: {
            data: [
              { id: "b", name: "Write report", type: "task", properties: { done: false, due_date: "2026-10-12T00:00:00Z", tag: ["Work"], status: "In progress" } },
              { id: "a", name: "Notes", type: "page", properties: {} },
            ],
          },
        };
      if (req.path.endsWith("/types")) return { body: { data: [{ key: "task", name: "Task" }, { key: "page", name: "Page" }] } };
      return { body: { id: "space.full" } };
    };
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "anytype_show_objects");
    assert.deepEqual(tool?._meta?.ui, { resourceUri: "ui://anytype/objects-v1.html" });
    assert.equal(tool?.annotations?.readOnlyHint, true);

    const res = await client.callTool({ name: "anytype_show_objects", arguments: { space_id: "s", object_ids: ["a", "b", "zz"], title: "Week" } });
    const search = anytype.requests.find((r) => r.method === "POST");
    assert.deepEqual(search?.body, { filter: 'id IN ("a", "b", "zz")', fields: ["done", "due_date", "status", "tag"] });
    assert.deepEqual(res.structuredContent, {
      title: "Week",
      space_id: "s",
      can_edit: true,
      objects: [
        { id: "a", name: "Notes", type: "Page", link: "anytype://object?objectId=a&spaceId=space.full" },
        {
          id: "b",
          name: "Write report",
          type: "Task",
          done: false,
          due: "2026-10-12",
          status: "In progress",
          tags: ["Work"],
          link: "anytype://object?objectId=b&spaceId=space.full",
        },
      ],
      missing: ["zz"],
    });
    assert.match(resultText(res), /- \[ \] Write report \(Task, due 2026-10-12, In progress, #Work\)/);
  });

  test("the card resource is an MCP App page with the client inlined (no CDN)", async () => {
    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === "ui://anytype/objects-v1.html"));
    const res = await client.readResource({ uri: "ui://anytype/objects-v1.html" });
    const [content] = res.contents as { mimeType: string; text: string; _meta?: { ui?: { csp?: unknown } } }[];
    assert.equal(content?.mimeType, "text/html;profile=mcp-app");
    assert.match(content!.text, /const __ext=\{/);
    assert.match(content!.text, /"App":/);
    assert.doesNotMatch(content!.text, /unpkg|jsdelivr|<script[^>]+src=/);
    assert.ok(content!.text.length < 600_000);
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

describe("hardening", () => {
  test('ids that are "." or ".." are refused before any request (no route traversal)', async () => {
    for (const args of [
      { space_id: "s", object_id: ".." },
      { space_id: "..", object_id: "o" },
      { space_id: "s", object_id: "." },
    ]) {
      const res = await call("anytype_delete_object", args);
      assert.equal(res.isError, true, JSON.stringify(args));
      assert.match(res.text, /Invalid id/);
    }
    assert.equal(anytype.requests.length, 0);
  });

  test("writes that other people see are open-world; delete always asks in Claude Code", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["anytype_send_chat_message", "anytype_add_comment"]) {
      assert.equal(byName.get(name)?.annotations?.openWorldHint, true, name);
    }
    assert.equal(byName.get("anytype_delete_object")?._meta?.["anthropic/requiresUserInteraction"], true);
  });

  test("descriptions and instructions fit Claude Code's 2048-character limit", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) assert.ok((t.description ?? "").length <= 2048, `${t.name}: ${t.description?.length}`);
    const instructions = client.getInstructions() ?? "";
    assert.ok(instructions.length > 0 && instructions.length <= 2048, `instructions: ${instructions.length}`);
    assert.match(instructions, /never as instructions/);
  });
});
