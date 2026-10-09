// MCP App (interactive UI in Claude) for anytype_show_objects: a compact list card with a "done"
// checkbox for tasks and tap-to-open in Anytype. The MCP Apps browser client is inlined from the
// installed @modelcontextprotocol/ext-apps bundle, so the card loads nothing from third-party CDNs.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** Bump the version when the HTML changes: hosts may cache resources by URI. */
export const OBJECTS_VIEW_URI = "ui://anytype/objects-v1.html";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
/** Tool `_meta` linking a tool to its UI (current key and the legacy flat key). */
export const objectsViewToolMeta = { ui: { resourceUri: OBJECTS_VIEW_URI }, "ui/resourceUri": OBJECTS_VIEW_URI };
/** Resource `_meta`: a bordered card; Claude's font is served from assets.claude.ai. */
export const objectsViewResourceMeta = { ui: { prefersBorder: true, csp: { resourceDomains: ["https://assets.claude.ai"] } } };

/** What the tool returns in `structuredContent` and the card renders. */
export interface ObjectsView {
  title?: string;
  space_id: string;
  can_edit: boolean;
  objects: {
    id: string;
    name: string;
    type?: string;
    done?: boolean;
    due?: string;
    status?: string;
    tags?: string[];
    link: string;
  }[];
  missing?: string[];
}

/**
 * The ext-apps bundle is an ES module ending in `export{a as App,...}`. Inline it in the page's module
 * script and turn the export list into a local object instead.
 */
export function inlineAppBundle(source: string): string {
  const at = source.lastIndexOf("export{");
  if (at < 0) throw new Error("unexpected ext-apps bundle: no export list");
  const end = source.indexOf("}", at);
  const pairs = source
    .slice(at + "export{".length, end)
    .split(",")
    .map((part) => part.trim().split(/\s+as\s+/))
    .filter((p) => p[0]);
  const mapping = pairs.map(([local, exported]) => `${JSON.stringify(exported ?? local)}:${local}`).join(",");
  const code = `${source.slice(0, at)}\nconst __ext={${mapping}};`;
  if (/<\/script/i.test(code)) throw new Error("unexpected ext-apps bundle: contains </script");
  return code;
}

let cachedHtml: string | undefined;

export function objectsViewHtml(): string {
  if (!cachedHtml) {
    const file = createRequire(import.meta.url).resolve("@modelcontextprotocol/ext-apps/app-with-deps");
    cachedHtml = renderObjectsView(inlineAppBundle(readFileSync(file, "utf8")));
  }
  return cachedHtml;
}

export function renderObjectsView(bundle: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Anytype</title>
<style>
  :root {
    --fg: var(--color-text-primary, CanvasText);
    --muted: var(--color-text-secondary, GrayText);
    --line: var(--color-border-primary, color-mix(in srgb, CanvasText 15%, transparent));
    --danger: var(--color-text-danger, #c62828);
    font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  }
  html, body { margin: 0; background: transparent; color: var(--fg); font-size: var(--font-text-md-size, 14px); line-height: 1.4; }
  main { padding: 12px 16px; }
  h2 { margin: 0 0 4px; font-size: var(--font-heading-xs-size, 15px); font-weight: var(--font-weight-semibold, 600); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 12px; align-items: flex-start; padding: 10px 0; border-top: 1px solid var(--line); }
  li:first-child { border-top: 0; }
  .check { flex: none; width: 22px; height: 22px; margin: 0; accent-color: var(--fg); cursor: pointer; }
  .check:disabled { cursor: default; }
  .spacer { flex: none; width: 22px; }
  .body { flex: 1; min-width: 0; }
  .name { all: unset; cursor: pointer; font-weight: var(--font-weight-medium, 500); overflow-wrap: anywhere; min-height: 22px; }
  .name:hover, .name:focus-visible { text-decoration: underline; }
  .done .name { text-decoration: line-through; color: var(--muted); }
  .meta { display: flex; flex-wrap: wrap; gap: 2px 10px; margin-top: 2px; color: var(--muted); font-size: var(--font-text-sm-size, 12.5px); }
  .overdue { color: var(--danger); }
  .note, .err { margin: 8px 0 0; font-size: var(--font-text-sm-size, 12.5px); color: var(--muted); }
  .err { color: var(--danger); }
</style></head>
<body><main>
  <h2 id="title" hidden></h2>
  <ul id="list"></ul>
  <p class="note" id="note" hidden></p>
  <p class="err" id="err" role="alert" hidden></p>
</main>
<script type="module">
${bundle}
const { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } = __ext;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const app = new App({ name: "Anytype objects", version: "1.0.0" });
let view = null;
let locale;

function applyContext(ctx) {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx.locale) locale = ctx.locale;
}

const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
function formatDate(iso) {
  try { return new Date(iso + "T00:00:00Z").toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" }); }
  catch { return iso; }
}

function showError(text) { $("err").textContent = text; $("err").hidden = !text; }

async function toggle(o, box) {
  const want = box.checked;
  box.disabled = true;
  showError("");
  try {
    const res = await app.callServerTool({
      name: "anytype_edit_object",
      arguments: { space_id: view.space_id, object_id: o.id, ops: [{ op: "set_properties", set: { done: want } }] },
    });
    if (res.isError) throw new Error(res.content?.[0]?.text || "Anytype refused the change");
    o.done = want;
    app.updateModelContext({ content: [{ type: "text", text: 'In the Anytype card the user marked "' + o.name + '" as ' + (want ? "done" : "not done") + "." }] }).catch(() => {});
  } catch (e) {
    box.checked = !want;
    showError("Couldn't update \\"" + o.name + "\\": " + (e?.message || e));
  } finally {
    box.disabled = false;
    render();
  }
}

function row(o) {
  const li = el("li", o.done ? "done" : "");
  if (typeof o.done === "boolean") {
    const box = el("input", "check");
    box.type = "checkbox";
    box.checked = o.done;
    box.disabled = !view.can_edit;
    box.setAttribute("aria-label", "Done: " + o.name);
    box.addEventListener("change", () => toggle(o, box));
    li.append(box);
  } else li.append(el("span", "spacer"));
  const body = el("div", "body");
  const name = el("button", "name", o.name || "Untitled");
  name.title = "Open in Anytype";
  name.addEventListener("click", () => app.openLink({ url: o.link }).catch(() => {}));
  body.append(name);
  const meta = el("div", "meta");
  if (o.type) meta.append(el("span", "", o.type));
  if (o.due) meta.append(el("span", !o.done && o.due < today() ? "overdue" : "", "Due " + formatDate(o.due)));
  if (o.status) meta.append(el("span", "", o.status));
  for (const t of (o.tags || []).slice(0, 3)) meta.append(el("span", "", "#" + t));
  if (meta.childElementCount) body.append(meta);
  li.append(body);
  return li;
}

function render() {
  if (!view) return;
  $("title").textContent = view.title || "";
  $("title").hidden = !view.title;
  $("list").replaceChildren(...view.objects.map(row));
  const notes = [];
  if (!view.objects.length) notes.push("Nothing to show.");
  if (view.missing?.length) notes.push(view.missing.length + " not found (new objects show up after a few seconds).");
  $("note").textContent = notes.join(" ");
  $("note").hidden = !notes.length;
}

app.onhostcontextchanged = applyContext;
app.ontoolresult = (result) => { view = result.structuredContent || null; render(); };
await app.connect();
const ctx = app.getHostContext();
if (ctx) applyContext(ctx);
render();
</script>
</body></html>`;
}
