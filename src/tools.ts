import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AnytypeApiError, type AnytypeClient, seg } from "./anytype/client.js";

const EDIT_OPS = [
  "set_properties",
  "set_type",
  "update_block",
  "replace_subtree",
  "insert_blocks",
  "move_block",
  "delete_block",
  "replace_text",
  "set_cell",
  "update_view",
  "insert_view",
  "move_view",
  "delete_view",
  "add_items",
  "remove_items",
] as const;

const spaceId = z.string().min(1).describe("Space id, as returned by anytype_list_spaces or search results");
const objectId = z.string().min(1).describe("Object id");
const limit = z.number().int().min(1).max(100).optional().describe("Page size (default 25)");
const offset = z.number().int().min(0).optional().describe("Page offset (default 0)");

const ok = (data: unknown, extra?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(extra ? { ...extra, ...(data as object) } : data, null, 2) }],
});

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    // Surface API errors verbatim: Anytype's messages explain how to fix the request.
    const text =
      err instanceof AnytypeApiError
        ? `${err.message}\n${JSON.stringify(err.body, null, 2)}`
        : `Error: ${err instanceof Error ? err.message : String(err)}`;
    return { isError: true, content: [{ type: "text", text }] };
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerTools(server: McpServer, api: AnytypeClient) {
  server.registerTool(
    "anytype_list_spaces",
    {
      title: "List spaces",
      description: "List the Anytype spaces this connector can access. Use the returned id as space_id in other tools.",
      inputSchema: z.object({ limit, offset }),
      annotations: READ_ONLY,
    },
    ({ limit, offset }) => run(async () => ok((await api.get("/v2/spaces", { limit, offset })).data)),
  );

  server.registerTool(
    "anytype_search",
    {
      title: "Search objects",
      description: `Search Anytype objects (pages, notes, tasks, etc.) by full text, type and property filter.
Omit space_id to search across all accessible spaces (rows then include space_id).
\`filter\` is a compact expression over property keys, e.g.
  done = false AND (due_date < currentWeek() OR due_date IS EMPTY)
  status IN ("In progress", "Blocked")
  tag HAS ALL ("urgent", "client")
  created_date > daysAgo(7)
Select/tag values are option names. Operators: = != > < >= <= CONTAINS, NOT CONTAINS, IN, NOT IN, HAS ALL, IS [NOT] EMPTY, EXISTS; combine with AND/OR and parentheses.
Use anytype_list_types / anytype_list_properties to discover type and property keys.`,
      inputSchema: z.object({
        space_id: spaceId.optional(),
        query: z.string().max(4096).optional().describe("Full-text query over names and content"),
        type: z.string().optional().describe("One type key, e.g. page, task, note"),
        filter: z.string().max(4096).optional().describe("Compact filter expression (see description)"),
        sorts: z
          .array(
            z.object({
              property: z.string(),
              direction: z.enum(["asc", "desc"]).optional(),
              empty_placement: z.enum(["start", "end"]).optional(),
            }),
          )
          .max(10)
          .optional()
          .describe('e.g. [{"property":"last_modified_date","direction":"desc"}]'),
        fields: z.array(z.string()).max(25).optional().describe("Extra property keys to include per row"),
        limit,
        offset,
      }),
      annotations: READ_ONLY,
    },
    ({ space_id, limit, offset, ...body }) =>
      run(async () => {
        const path = space_id ? `/v2/spaces/${seg(space_id)}/search` : "/v2/search";
        return ok((await api.post(path, body, { limit, offset })).data);
      }),
  );

  server.registerTool(
    "anytype_fetch",
    {
      title: "Fetch object",
      description: `Read one Anytype object.
format:
- "markdown" (default): properties + body as markdown. Best for reading.
- "outline": every block's id, type, indent and first 80 chars. Use it to find block ids before editing a large object.
- "blocks": full AnyBlock JSON (optionally only the subtree of \`block\`). Use for precise block-level edits.
The returned etag can be passed as if_match to anytype_edit_object.`,
      inputSchema: z.object({
        space_id: spaceId,
        object_id: objectId,
        format: z.enum(["markdown", "outline", "blocks"]).optional(),
        block: z.string().optional().describe('Only with format "blocks": return just this block\'s subtree'),
      }),
      annotations: READ_ONLY,
    },
    ({ space_id, object_id, format = "markdown", block }) =>
      run(async () => {
        const path = `/v2/spaces/${seg(space_id)}/objects/${seg(object_id)}`;
        if (format === "markdown") {
          const [md, props] = await Promise.all([
            api.get<{ markdown: string; type: string; etag?: string }>(path, { format: "md" }),
            api.get<{ properties?: unknown }>(path, { include: "properties" }),
          ]);
          return ok({
            id: object_id,
            type: md.data.type,
            etag: md.etag ?? md.data.etag,
            properties: props.data.properties,
            markdown: md.data.markdown,
          });
        }
        const res = await api.get(path, format === "outline" ? { outline: true } : { block });
        return ok(res.data, { etag: res.etag });
      }),
  );

  server.registerTool(
    "anytype_list_types",
    {
      title: "List object types",
      description: "List object types in a space (key and name). Use the key as `type` when creating or searching.",
      inputSchema: z.object({ space_id: spaceId, limit, offset }),
      annotations: READ_ONLY,
    },
    ({ space_id, limit, offset }) =>
      run(async () => ok((await api.get(`/v2/spaces/${seg(space_id)}/types`, { limit, offset })).data)),
  );

  server.registerTool(
    "anytype_get_type",
    {
      title: "Get object type",
      description: "Get one object type with its properties and templates.",
      inputSchema: z.object({ space_id: spaceId, type: z.string().min(1).describe("Type key, e.g. task") }),
      annotations: READ_ONLY,
    },
    ({ space_id, type }) => run(async () => ok((await api.get(`/v2/spaces/${seg(space_id)}/types/${seg(type)}`)).data)),
  );

  server.registerTool(
    "anytype_list_properties",
    {
      title: "List properties",
      description:
        "List properties (fields) defined in a space with their keys and formats. Use the keys in filters, sorts and set_properties.",
      inputSchema: z.object({ space_id: spaceId, limit, offset }),
      annotations: READ_ONLY,
    },
    ({ space_id, limit, offset }) =>
      run(async () => ok((await api.get(`/v2/spaces/${seg(space_id)}/properties`, { limit, offset })).data)),
  );

  server.registerTool(
    "anytype_list_property_options",
    {
      title: "List property options",
      description: "List the options (tags / select values) of a select or multi-select property.",
      inputSchema: z.object({ space_id: spaceId, key: z.string().min(1).describe("Property key"), limit, offset }),
      annotations: READ_ONLY,
    },
    ({ space_id, key, limit, offset }) =>
      run(async () =>
        ok((await api.get(`/v2/spaces/${seg(space_id)}/properties/${seg(key)}/options`, { limit, offset })).data),
      ),
  );

  server.registerTool(
    "anytype_get_op_schema",
    {
      title: "Get edit operation schema",
      description: "Get the JSON schema and an example for one anytype_edit_object operation.",
      inputSchema: z.object({ op: z.enum(EDIT_OPS) }),
      annotations: READ_ONLY,
    },
    ({ op }) => run(async () => ok((await api.get(`/v2/schemas/ops/${seg(op)}`)).data)),
  );

  server.registerTool(
    "anytype_create_object",
    {
      title: "Create object",
      description: `Create an Anytype object (page, note, task, ...) with a markdown body.
Don't repeat the name as a leading heading in markdown — Anytype shows the name above the body.
properties maps property keys to values; select/tag values are option names, e.g. {"status": ["In progress"], "due_date": "2026-11-01"}.`,
      inputSchema: z.object({
        space_id: spaceId,
        type: z.string().min(1).describe("Type key, e.g. page, note, task"),
        name: z.string().max(4096).optional(),
        markdown: z.string().max(1_048_576).optional().describe("Body in markdown"),
        properties: z.record(z.string(), z.unknown()).optional(),
        template: z.string().optional().describe('Template id, or "none". Omit to use the type\'s default template'),
        create_missing_options: z.boolean().optional().describe("Create select options that don't exist yet"),
        dry_run: z.boolean().optional().describe("Validate without creating"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ space_id, create_missing_options, dry_run, ...body }) =>
      run(async () =>
        ok((await api.post(`/v2/spaces/${seg(space_id)}/objects`, body, { create_missing_options, dry_run })).data),
      ),
  );

  server.registerTool(
    "anytype_edit_object",
    {
      title: "Edit object",
      description: `Edit an existing Anytype object with a list of operations applied atomically (all or nothing, max 512).
Common ops:
- {"op":"replace_text","find":"old text","replace":"new text"} — find must occur in exactly one block (or pass "id")
- {"op":"insert_blocks","markdown":"## New section\\n- item"} — appends to the end; add "after"/"before"/"inside": <block id> or "position":"first"
- {"op":"update_block","match":"Draft timeline","set":{"checked":true}}
- {"op":"delete_block","match":"Obsolete section","recursive":true}
- {"op":"set_properties","set":{"status":["Done"]},"add":{"tag":["Urgent"]},"unset":["due_date"]}
- {"op":"set_type","type":"task"}
Other ops: ${EDIT_OPS.join(", ")}. Call anytype_get_op_schema for any op's exact fields.
Get block ids from anytype_fetch with format "outline". Pass if_match (etag from anytype_fetch) to avoid overwriting concurrent changes.`,
      inputSchema: z.object({
        space_id: spaceId,
        object_id: objectId,
        ops: z
          .array(z.object({ op: z.enum(EDIT_OPS) }).passthrough())
          .min(1)
          .max(512),
        if_match: z.string().optional().describe("etag the object must still carry"),
        create_missing_options: z.boolean().optional(),
        dry_run: z.boolean().optional().describe("Validate and report without committing"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ space_id, object_id, ops, if_match, create_missing_options, dry_run }) =>
      run(async () => {
        const res = await api.patch(
          `/v2/spaces/${seg(space_id)}/objects/${seg(object_id)}`,
          { ops },
          {
            query: { create_missing_options, dry_run },
            headers: if_match ? { "If-Match": if_match.startsWith('"') ? if_match : `"${if_match}"` } : undefined,
          },
        );
        return ok(res.data, { etag: res.etag });
      }),
  );

  server.registerTool(
    "anytype_delete_object",
    {
      title: "Delete object",
      description:
        "Move an object to the bin. Anytype only allows deleting objects that were created through this connector.",
      inputSchema: z.object({ space_id: spaceId, object_id: objectId, dry_run: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ space_id, object_id, dry_run }) =>
      run(async () =>
        ok((await api.delete(`/v2/spaces/${seg(space_id)}/objects/${seg(object_id)}`, { dry_run })).data),
      ),
  );
}
