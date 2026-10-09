// Turns Anytype API errors and warnings into text a model can act on. Anytype's issues carry a `hint`
// written in terms of HTTP routes plus `see_also` refs naming the operations (OpenAPI operationIds);
// we keep the hint and add the matching tool call, so the model doesn't have to map routes to tools.

export interface ApiRef {
  op?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
}

export interface ApiIssue {
  path?: string;
  message: string;
  hint?: string;
  see_also?: ApiRef[];
}

/** operationId -> tool name, and how path params are renamed for the tool. */
const OP_TOOLS: Record<string, { tool: string; rename?: Record<string, string> }> = {
  list_spaces: { tool: "anytype_list_spaces" },
  search_global: { tool: "anytype_search" },
  search_space: { tool: "anytype_search" },
  get_object: { tool: "anytype_fetch" },
  patch_object: { tool: "anytype_edit_object" },
  create_object: { tool: "anytype_create_object" },
  delete_object: { tool: "anytype_delete_object" },
  list_types: { tool: "anytype_list_types" },
  get_type: { tool: "anytype_get_type" },
  list_properties: { tool: "anytype_list_properties" },
  list_property_options: { tool: "anytype_list_property_options" },
  get_op_schema: { tool: "anytype_get_op_schema" },
  get_schema: { tool: "anytype_get_schema" },
  list_schemas: { tool: "anytype_get_schema" },
  list_templates: { tool: "anytype_list_templates" },
  list_members: { tool: "anytype_list_members" },
  get_collection_objects: { tool: "anytype_list_items", rename: { collection_id: "list_id" } },
  get_query_objects: { tool: "anytype_list_items", rename: { query_id: "list_id" } },
  get_collection_views: { tool: "anytype_list_views", rename: { collection_id: "list_id" } },
  get_query_views: { tool: "anytype_list_views", rename: { query_id: "list_id" } },
  create_collection: { tool: "anytype_create_collection" },
  create_query: { tool: "anytype_create_query" },
  create_discussion: { tool: "anytype_add_comment" },
  list_chats: { tool: "anytype_list_chats" },
  get_chat_messages: { tool: "anytype_read_chat" },
  add_chat_message: { tool: "anytype_send_chat_message" },
  edit_chat_message: { tool: "anytype_edit_chat_message" },
  delete_chat_message: { tool: "anytype_delete_chat_message" },
  toggle_chat_reaction: { tool: "anytype_react_to_message" },
  create_chat: { tool: "anytype_create_chat" },
  get_space: { tool: "anytype_get_space" },
  update_space: { tool: "anytype_update_space" },
  create_type: { tool: "anytype_create_type" },
  update_type: { tool: "anytype_update_type" },
  create_property: { tool: "anytype_create_property" },
  update_property: { tool: "anytype_update_property" },
  upload_file: { tool: "anytype_upload_file" },
  download_file: { tool: "anytype_get_file" },
};

/** Query values arrive as strings; tools take booleans and numbers. */
function toArgValue(value: string): unknown {
  if (value === "true" || value === "false") return value === "true";
  return /^\d+$/.test(value) ? Number(value) : value;
}

/** Renders one see_also ref as a suggested tool call, e.g. `anytype_list_properties {"space_id":"x"}`. */
export function refToToolCall(ref: ApiRef): string {
  const query = Object.entries(ref.query ?? {});
  if (!ref.op) {
    const args = query.map(([k, v]) => `${k}: ${JSON.stringify(toArgValue(v))}`).join(", ");
    return `retry the same call${args ? ` with ${args}` : ""}`;
  }
  const mapping = OP_TOOLS[ref.op];
  if (!mapping) return `${ref.op} (not available as a tool)`;
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ref.params ?? {})) args[mapping.rename?.[k] ?? k] = v;
  for (const [k, v] of query) {
    if (ref.op === "get_object" && k === "outline") args.format = "outline";
    else if (ref.op === "get_object" && k === "format") continue; // markdown is the tool's default
    else args[k] = toArgValue(v);
  }
  const rendered = Object.keys(args).length ? ` ${JSON.stringify(args)}` : "";
  return `${mapping.tool}${rendered}`;
}

/** Formats issues (errors or warnings) as indented lines with tool suggestions. */
export function formatIssues(issues: ApiIssue[]): string[] {
  const lines: string[] = [];
  for (const issue of issues) {
    lines.push(`- ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
    if (issue.hint) lines.push(`  hint: ${issue.hint}`);
    const calls = [...new Set((issue.see_also ?? []).map(refToToolCall))];
    if (calls.length) lines.push(`  next: ${calls.join(" | ")}`);
  }
  return lines;
}

/** Text of a failed Anytype call: status, message, code, then each issue with hints. */
export function formatApiError(status: number, body: unknown): string {
  if (!body || typeof body !== "object") {
    return `Anytype API ${status}: ${typeof body === "string" && body ? body : "request failed"}`;
  }
  const b = body as { code?: string; message?: string; issues?: ApiIssue[] };
  const head = `Anytype API ${status}: ${b.message ?? "request failed"}${b.code ? ` (${b.code})` : ""}`;
  const issues = Array.isArray(b.issues) ? formatIssues(b.issues) : [];
  return [head, ...issues, ...statusHint(status, issues.length > 0)].join("\n");
}

function statusHint(status: number, hasIssues: boolean): string[] {
  if (hasIssues) return [];
  if (status === 401) return ["The connector's Anytype API key was rejected; the server operator must issue a new one."];
  if (status === 403) return ["This API key has no access to that space or object; anytype_list_spaces shows what it can reach."];
  if (status === 404) return ["Check the ids: anytype_search or anytype_list_spaces return valid ones."];
  if (status === 412) return ["The object changed since it was read: fetch it again and retry with the new etag."];
  return [];
}
