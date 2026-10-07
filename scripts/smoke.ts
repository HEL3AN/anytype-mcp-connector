// End-to-end check against a running server: `npm run smoke [-- --write]`.
// --write creates a temporary object, edits it and deletes it again.
// MCP_PROTOCOL=legacy forces the 2025 initialize handshake; default negotiates (2026-07-28 when offered).
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp";
const write = process.argv.includes("--write");

const client = new Client(
  { name: "smoke", version: "0.0.0" },
  { versionNegotiation: { mode: process.env.MCP_PROTOCOL === "legacy" ? "legacy" : "auto" } },
);
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
  const status = res.isError ? "FAIL" : "ok  ";
  console.log(`${status} ${name} ${JSON.stringify(args).slice(0, 80)}\n     ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  if (res.isError) process.exitCode = 1;
  return res.isError ? undefined : JSON.parse(text);
}

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`);
for (const t of tools) {
  const a = t.annotations ?? {};
  console.log(`  ${t.name.padEnd(30)} ${a.title ?? t.title ?? "-"} ro=${a.readOnlyHint} destructive=${a.destructiveHint}`);
}

const spaces = await call("anytype_list_spaces");
const space_id: string | undefined = process.env.SPACE_ID ?? spaces?.data?.[0]?.id;
if (!space_id) {
  console.error("No accessible spaces: check the API key's grants (or set SPACE_ID).");
  process.exit(1);
}
const found = await call("anytype_search", { space_id, query: "", limit: 3 });
await call("anytype_search", { query: "a", limit: 2 });
await call("anytype_search", { space_id, filter: "created_date > daysAgo(30)", limit: 2 });
await call("anytype_list_types", { space_id });
await call("anytype_get_type", { space_id, type: "task" });
await call("anytype_list_properties", { space_id, limit: 5 });
await call("anytype_get_op_schema", { op: "replace_text" });
if (found?.data?.[0]) {
  const object_id = found.data[0].id;
  await call("anytype_fetch", { space_id, object_id });
  await call("anytype_fetch", { space_id, object_id, format: "outline" });
}

if (write) {
  const created = await call("anytype_create_object", {
    space_id,
    type: "page",
    name: "[connector smoke test]",
    markdown: "First paragraph with Q3.\n\n- item one",
  });
  const object_id: string | undefined = created?.id ?? created?.object?.id ?? created?.data?.id;
  console.log("created id:", object_id, "keys:", created && Object.keys(created));
  if (object_id) {
    const before = await call("anytype_fetch", { space_id, object_id });
    await call("anytype_edit_object", {
      space_id,
      object_id,
      if_match: before?.etag,
      ops: [
        { op: "replace_text", find: "Q3", replace: "Q4" },
        { op: "insert_blocks", markdown: "## Added section\n- [ ] todo" },
      ],
    });
    const after = await call("anytype_fetch", { space_id, object_id });
    console.log("markdown after edit:\n" + after?.markdown);
    await call("anytype_delete_object", { space_id, object_id });
  }
}

await client.close();
