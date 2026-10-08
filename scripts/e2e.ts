// End-to-end test against a real Anytype (desktop or anytype-cli): `npm run e2e`.
// Runs the connector in-process (no OAuth) and drives every tool through an MCP client, creating,
// editing and deleting a temporary object. Writes happen ONLY in the space named E2E_SPACE
// (default "API_TEST"); use an API key scoped to that space. Reads .env.local (API_KEY, ANYTYPE_API_URL).
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { loadConfig, loadEnvFiles } from "../src/config.js";
import { mcpClient, resultText, serve } from "../test/helpers.js";

loadEnvFiles();
const spaceName = process.env.E2E_SPACE ?? "API_TEST";
const config = loadConfig({ ...process.env, AUTH_DISABLED: "true", HOST: "127.0.0.1", OWNER_PASSWORD: "" });
const server = await serve(createApp(config, { log: () => {} }).app);
const client = await mcpClient(`${server.url}/mcp`);

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
  return JSON.parse(text);
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

  await step("search finds the object", async () => {
    let found = false;
    for (let i = 0; i < 10 && !found; i++) {
      const res = await call("anytype_search", { space_id, query: marker, limit: 5 });
      found = res.data.some((o: { id: string }) => o.id === object_id);
      if (!found) await new Promise((r) => setTimeout(r, 500)); // the index catches up asynchronously
    }
    assert.ok(found, "object appears in search results");
  });
} finally {
  if (object_id) {
    await step("delete the object", async () => {
      await call("anytype_delete_object", { space_id, object_id });
    });
  }
  await client.close();
  await server.close();
}

console.log(failures ? `\n${failures} step(s) failed` : "\nall steps passed");
process.exit(failures ? 1 : 0);
