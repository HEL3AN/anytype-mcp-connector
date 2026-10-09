// End-to-end test against a real Anytype (desktop or anytype-cli): `npm run e2e`.
// Runs the connector in-process (no OAuth) and drives every tool through an MCP client, creating,
// editing and deleting a temporary object. Writes happen ONLY in the space named E2E_SPACE
// (default "API_TEST"); use an API key scoped to that space. Reads .env.local (API_KEY, ANYTYPE_API_URL).
import assert from "node:assert/strict";
import { AnytypeClient } from "../src/anytype/client.js";
import { createApp } from "../src/app.js";
import { loadConfig, loadEnvFiles } from "../src/config.js";
import { mcpClient, resultText, serve } from "../test/helpers.js";

loadEnvFiles();
const spaceName = process.env.E2E_SPACE ?? "API_TEST";
const config = loadConfig({ ...process.env, AUTH_DISABLED: "true", HOST: "127.0.0.1", OWNER_PASSWORD: "" });
const server = await serve(createApp(config, { log: () => {} }).app);
const client = await mcpClient(`${server.url}/mcp`);
// Types and properties have no delete tool (on purpose); the cleanup removes them directly.
const api = new AnytypeClient(config.anytypeUrl, config.anytypeApiKey);

let failures = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${err instanceof Error ? err.message : err}`);
  }
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = resultText(res);
  if (res.isError) throw new Error(`${name} failed: ${text.slice(0, 500)}`);
  // Warnings, if any, follow the JSON on later lines.
  return JSON.parse(text.split("\n")[0]!);
}

async function callError(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  assert.equal(res.isError, true, `${name} should fail`);
  return resultText(res);
}

const spaces = (await call("anytype_list_spaces")).data as { id: string; name: string }[];
const space = spaces.find((s) => s.name === spaceName);
if (!space) {
  console.error(`No space named "${spaceName}" is visible to this API key (visible: ${spaces.length}). Refusing to run.`);
  process.exit(1);
}
const space_id = space.id;
const marker = `e2e-${Date.now().toString(36)}`;
let object_id: string | undefined;
const extraIds: string[] = [];
const schemaPaths: string[] = [];
console.log(`Anytype ${config.anytypeUrl}, space "${spaceName}" (${space_id.slice(-6)}), marker ${marker}`);

try {
  await step("read-only tools", async () => {
    const types = await call("anytype_list_types", { space_id });
    assert.ok(types.data.some((t: { key: string }) => t.key === "page"), "space has the page type");
    await call("anytype_get_type", { space_id, type: "page" });
    await call("anytype_list_properties", { space_id, limit: 5 });
    const schema = await call("anytype_get_op_schema", { op: "replace_text" });
    assert.ok(schema, "op schema returned");
  });

  await step("create an object with a markdown body", async () => {
    const created = await call("anytype_create_object", {
      space_id,
      type: "page",
      name: `[connector e2e] ${marker}`,
      markdown: `First paragraph with ${marker} and Q3.\n\n- item one\n- item two`,
    });
    object_id = created?.object?.id ?? created?.id ?? created?.data?.id;
    assert.ok(object_id, `created object id (keys: ${Object.keys(created ?? {})})`);
  });
  if (!object_id) throw new Error("cannot continue without the created object");

  let etag: string | undefined;
  await step("fetch as markdown and outline", async () => {
    const md = await call("anytype_fetch", { space_id, object_id });
    assert.match(md.markdown, new RegExp(`${marker} and Q3`));
    assert.match(md.markdown, /item two/);
    assert.ok(md.etag, "markdown fetch returns an etag");
    etag = md.etag;
    const outline = await call("anytype_fetch", { space_id, object_id, format: "outline" });
    assert.ok(outline.etag, "outline returns an etag");
  });

  await step("dry run does not change the object", async () => {
    await call("anytype_edit_object", {
      space_id,
      object_id,
      dry_run: true,
      ops: [{ op: "replace_text", find: "Q3", replace: "DRYRUN" }],
    });
    const md = await call("anytype_fetch", { space_id, object_id });
    assert.doesNotMatch(md.markdown, /DRYRUN/);
  });

  await step("edit with if_match: replace_text + insert_blocks", async () => {
    await call("anytype_edit_object", {
      space_id,
      object_id,
      if_match: etag,
      ops: [
        { op: "replace_text", find: "Q3", replace: "Q4" },
        { op: "insert_blocks", markdown: "## Added section\n- [ ] todo" },
      ],
    });
    const md = await call("anytype_fetch", { space_id, object_id });
    assert.match(md.markdown, /Q4/);
    assert.match(md.markdown, /## Added section/);
  });

  await step("a stale etag is rejected", async () => {
    const text = await callError("anytype_edit_object", {
      space_id,
      object_id,
      if_match: etag,
      ops: [{ op: "replace_text", find: "Q4", replace: "Q5" }],
    });
    assert.match(text, /Anytype API 4\d\d/);
  });

  await step("comments: add, reply, list, edit, react, delete", async () => {
    const first = await call("anytype_add_comment", { space_id, object_id, text: `Comment **${marker}**` });
    assert.ok(first.chat_id && first.id, "comment posted");
    const reply = await call("anytype_add_comment", { space_id, object_id, text: "Reply", reply_to: first.id });
    const md = await call("anytype_fetch", { space_id, object_id });
    assert.equal(md.has_comments, true);
    const list = await call("anytype_list_comments", { space_id, object_id });
    assert.equal(list.messages.length, 2);
    assert.match(list.messages[0].text, new RegExp(marker));
    assert.equal(list.messages[1].reply_to, first.id);
    const ids = { space_id, chat_id: first.chat_id };
    await call("anytype_edit_chat_message", { ...ids, message_id: reply.id, text: "Edited reply" });
    const reacted = await call("anytype_react_to_message", { ...ids, message_id: first.id, emoji: "👍" });
    assert.equal(reacted.added, true);
    await call("anytype_delete_chat_message", { ...ids, message_id: reply.id });
    const after = await call("anytype_list_comments", { space_id, object_id });
    assert.equal(after.messages.length, 1);
    assert.deepEqual(after.messages[0].reactions, { "👍": 1 });
  });

  await step("space: get", async () => {
    const got = await call("anytype_get_space", { space_id });
    assert.equal(got.name, spaceName);
    const dry = await call("anytype_update_space", { space_id, description: "e2e dry run", dry_run: true });
    assert.ok(dry, "update_space dry run answered");
  });

  await step("schema: create and update a type and a property", async () => {
    const prop = await call("anytype_create_property", {
      space_id,
      name: `E2E mood ${marker}`,
      key: `e2e_mood_${marker.replace(/\W/g, "_")}`,
      format: "select",
      options: [{ name: "Calm" }],
    });
    assert.ok(prop.key, "property key");
    schemaPaths.push(`/v2/spaces/${space_id}/properties/${prop.key}`);
    await call("anytype_update_property", { space_id, key: prop.key, name: `E2E feeling ${marker}` });
    const type = await call("anytype_create_type", {
      space_id,
      name: `E2E meeting ${marker}`,
      key: `e2e_meeting_${marker.replace(/\W/g, "_")}`,
      icon: "📅",
      properties: [{ property: prop.key }, { name: `E2E room ${marker}`, format: "text" }],
    });
    assert.ok(type.key, "type key");
    schemaPaths.unshift(`/v2/spaces/${space_id}/types/${type.key}`);
    for (const created of type.created?.properties ?? []) schemaPaths.push(`/v2/spaces/${space_id}/properties/${created.key}`);
    await call("anytype_update_type", {
      space_id,
      type: type.key,
      name: `E2E meeting renamed ${marker}`,
      ops: [{ op: "add_property", property: "description" }],
    });
    const got = await call("anytype_get_type", { space_id, type: type.key });
    assert.match(JSON.stringify(got), /E2E meeting renamed/);
    assert.match(JSON.stringify(got), /E2E feeling/);
  });

  await step("files: upload from a URL, embed, read back as an image", async () => {
    const refused = await callError("anytype_upload_file", { space_id, url: "http://127.0.0.1:31009/v2/spaces" });
    assert.match(refused, /non-public/);
    const file = await call("anytype_upload_file", {
      space_id,
      url: "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png",
      name: `e2e-${marker}.png`,
    });
    assert.ok(file.id, "file id");
    extraIds.push(file.id);
    await call("anytype_edit_object", { space_id, object_id, ops: [{ op: "insert_blocks", markdown: `![logo](${file.id})` }] });
    const md = await call("anytype_fetch", { space_id, object_id });
    assert.match(md.markdown, new RegExp(`!\\[logo\\]\\(${file.id}\\)`));
    const res = await client.callTool({ name: "anytype_get_file", arguments: { space_id, file_id: file.id, width: 256 } });
    const [content] = res.content as { type: string; mimeType?: string }[];
    assert.equal(content?.type, "image", resultText(res).slice(0, 200));
    assert.equal(content?.mimeType, "image/png");
  });

  await step("collections and queries: create, list items and views", async () => {
    const col = await call("anytype_create_collection", { space_id, name: `[connector e2e] list ${marker}`, items: [object_id] });
    extraIds.push(col.id);
    const items = await call("anytype_list_items", { space_id, list_id: col.id });
    assert.deepEqual(items.data.map((o: { id: string }) => o.id), [object_id]);
    await call("anytype_list_views", { space_id, list_id: col.id });

    const q = await call("anytype_create_query", { space_id, name: `[connector e2e] query ${marker}`, type: "page" });
    extraIds.push(q.id);
    const rows = await call("anytype_list_items", { space_id, list_id: q.id, limit: 100 });
    assert.ok(Array.isArray(rows.data), "query rows (via the query endpoint fallback)");
  });

  await step("mention links show up as backlinks; fetch_many reads both", async () => {
    const linker = await call("anytype_create_object", {
      space_id,
      type: "page",
      name: `[connector e2e] linker ${marker}`,
      markdown: `See <mention object_id="${object_id}">the e2e page</mention>.`,
    });
    const linker_id = linker?.id ?? linker?.object?.id;
    assert.ok(linker_id, "linker created");
    extraIds.push(linker_id);
    let backlinks: { id: string; name: string }[] = [];
    for (let i = 0; i < 30 && !backlinks.some((b) => b.id === linker_id); i++) {
      backlinks = (await call("anytype_fetch", { space_id, object_id })).backlinks ?? [];
      if (!backlinks.some((b) => b.id === linker_id)) await new Promise((r) => setTimeout(r, 1000));
    }
    const back = backlinks.find((b) => b.id === linker_id);
    assert.ok(back, `linker among backlinks (${backlinks.length})`); // the collection links here too
    assert.match(back.name, /linker/);
    const many = await call("anytype_fetch_many", { space_id, object_ids: [object_id, linker_id], max_chars: 4000 });
    assert.deepEqual(many.objects.map((o: { id: string }) => o.id), [object_id, linker_id]);
    assert.match(many.objects[1].markdown, new RegExp(`anytype://object\\?objectId=${object_id}`));
  });

  await step("helpers: schema, templates, members, chats", async () => {
    const grammar = await call("anytype_get_schema", { kind: "filters" });
    assert.ok(grammar, "filter grammar");
    await call("anytype_list_templates", { space_id, type: "page" });
    const members = await call("anytype_list_members", { space_id });
    assert.ok(members.data.length >= 1, "at least the owner");
    await call("anytype_list_chats", { space_id });
  });

  await step("errors carry tool hints", async () => {
    const text = await callError("anytype_edit_object", {
      space_id,
      object_id,
      ops: [{ op: "replace_text", find: "text that is not there", replace: "x" }],
    });
    assert.match(text, /next: anytype_fetch/);
  });

  await step("search finds the object", async () => {
    let found = false;
    for (let i = 0; i < 30 && !found; i++) {
      const res = await call("anytype_search", { space_id, query: marker, limit: 5 });
      const row = res.data.find((o: { id: string }) => o.id === object_id);
      found = Boolean(row);
      if (row) assert.match(row.properties?.snippet ?? "", new RegExp(marker), "rows carry a snippet");
      if (!found) await new Promise((r) => setTimeout(r, 1000)); // full-text indexing is asynchronous (seconds)
    }
    assert.ok(found, "object appears in search results");
  });
} finally {
  for (const id of [...extraIds, ...(object_id ? [object_id] : [])]) {
    await step(`delete ${id.slice(-6)}`, async () => {
      await call("anytype_delete_object", { space_id, object_id: id });
    });
  }
  for (const path of schemaPaths) {
    await step(`delete ${path.split("/").slice(-2).join("/")}`, async () => {
      await api.delete(path);
    });
  }
  await client.close();
  await server.close();
}

console.log(failures ? `\n${failures} step(s) failed` : "\nall steps passed");
process.exit(failures ? 1 : 0);
