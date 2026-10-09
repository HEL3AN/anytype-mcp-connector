// MCP App (interactive UI in Claude) for anytype_show_objects: a compact list card with a "done"
// checkbox for tasks and tap-to-open in Anytype. The MCP Apps browser client is inlined from the
// installed @modelcontextprotocol/ext-apps bundle, so the card loads nothing from third-party CDNs.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** Bump the version when the HTML changes: hosts may cache resources by URI. */
export const OBJECTS_VIEW_URI = "ui://anytype/objects-v2.html";
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
 * script, wrapped in a function, and turn the export list into the function's return value.
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
  // A function scope keeps the bundle's minified top-level names away from the page script's own.
  const code = `const __ext=(()=>{\n${source.slice(0, at)}\nreturn {${mapping}};\n})();`;
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
    --line: var(--color-border-secondary, var(--color-border-primary, color-mix(in srgb, CanvasText 12%, transparent)));
    --pill: var(--color-background-secondary, color-mix(in srgb, CanvasText 7%, transparent));
    --hover: var(--color-background-tertiary, color-mix(in srgb, CanvasText 4%, transparent));
    --danger: var(--color-text-danger, #c62828);
    --radius: var(--border-radius-md, 8px);
    --sm: var(--font-text-sm-size, 13px);
    font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  }
  html, body { margin: 0; background: transparent; color: var(--fg); font-size: var(--font-text-md-size, 15px); line-height: 1.35; }
  main { padding: 10px 8px 8px; }
  header { display: flex; align-items: baseline; gap: 8px; padding: 0 8px 6px; }
  h2 { margin: 0; font-size: var(--font-text-md-size, 15px); font-weight: var(--font-weight-semibold, 600); }
  .count { color: var(--muted); font-size: var(--sm); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 10px; align-items: flex-start; padding: 7px 8px; border-radius: var(--radius); }
  li:hover { background: var(--hover); }
  li + li { box-shadow: 0 -1px 0 var(--line); }
  li:hover, li:hover + li { box-shadow: none; }
  .check { appearance: none; flex: none; width: 18px; height: 18px; margin: 1px 0 0; border: 1.5px solid var(--muted);
           border-radius: 5px; display: grid; place-items: center; cursor: pointer; background: transparent; }
  .check::after { content: ""; width: 9px; height: 5px; border: solid var(--color-text-inverse, Canvas); border-width: 0 0 2px 2px;
                  transform: translate(0, -1px) rotate(-45deg); opacity: 0; }
  .check:checked { background: var(--fg); border-color: var(--fg); }
  .check:checked::after { opacity: 1; }
  .check:disabled { cursor: default; opacity: .55; }
  .check:focus-visible { outline: 2px solid var(--color-ring-primary, Highlight); outline-offset: 2px; }
  .body { flex: 1; min-width: 0; }
  .name { all: unset; cursor: pointer; overflow-wrap: anywhere; }
  .name:hover, .name:focus-visible { text-decoration: underline; text-underline-offset: 2px; }
  .done .name { text-decoration: line-through; color: var(--muted); }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; margin-top: 3px; color: var(--muted); font-size: var(--sm); }
  .date { display: inline-flex; align-items: center; gap: 4px; }
  .date svg { width: 13px; height: 13px; }
  .overdue { color: var(--danger); }
  .pill { background: var(--pill); border-radius: 999px; padding: 0 8px; }
  .more { all: unset; cursor: pointer; display: block; margin: 4px 8px 0; color: var(--muted); font-size: var(--sm); padding: 6px 0; }
  .more:hover, .more:focus-visible { color: var(--fg); }
  .note, .err { margin: 6px 8px 0; font-size: var(--sm); color: var(--muted); }
  .err { color: var(--danger); }
</style></head>
<body><main>
  <header id="head" hidden><h2 id="title"></h2><span class="count" id="count"></span></header>
  <ul id="list"></ul>
  <button class="more" id="more" hidden></button>
  <p class="note" id="note" hidden></p>
  <p class="err" id="err" role="alert" hidden></p>
</main>
<script type="module">
${bundle}
const { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } = __ext;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const FOLDED = 6;
const STRINGS = {
  en: { untitled: "Untitled", open: "Open in Anytype", done: "Done", more: (n) => "Show " + n + " more", less: "Show less",
        empty: "Nothing to show.", missing: (n) => n + " not found (new objects show up after a few seconds).", failed: "Couldn't update" },
  ru: { untitled: "Без названия", open: "Открыть в Anytype", done: "Готово", more: (n) => "Ещё " + n, less: "Свернуть",
        empty: "Нечего показать.", missing: (n) => "Не найдено: " + n + " (новые объекты появляются через несколько секунд).", failed: "Не удалось изменить" },
};
const CALENDAR = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/></svg>';
const app = new App({ name: "Anytype objects", version: "2.0.0" });
let view = null;
let locale;
let expanded = false;
const t = () => STRINGS[(locale || navigator.language || "en").slice(0, 2)] || STRINGS.en;

function applyContext(ctx) {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx.locale) { locale = ctx.locale; render(); }
}

const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
function formatDate(iso) {
  const sameYear = iso.slice(0, 4) === today().slice(0, 4);
  try { return new Date(iso + "T00:00:00Z").toLocaleDateString(locale, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }); }
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
    showError(t().failed + " \\u201c" + o.name + "\\u201d: " + (e?.message || e));
  } finally {
    box.disabled = false;
    render();
  }
}

function row(o, showType) {
  const li = el("li", o.done ? "done" : "");
  if (typeof o.done === "boolean") {
    const box = el("input", "check");
    box.type = "checkbox";
    box.checked = o.done;
    box.disabled = !view.can_edit;
    box.setAttribute("aria-label", t().done + ": " + o.name);
    box.addEventListener("change", () => toggle(o, box));
    li.append(box);
  }
  const body = el("div", "body");
  const name = el("button", "name", o.name || t().untitled);
  name.title = t().open;
  name.addEventListener("click", () => app.openLink({ url: o.link }).catch(() => {}));
  body.append(name);
  const meta = el("div", "meta");
  if (o.due) {
    const d = el("span", "date" + (!o.done && o.due < today() ? " overdue" : ""));
    d.innerHTML = CALENDAR;
    d.append(formatDate(o.due));
    meta.append(d);
  }
  if (o.status) meta.append(el("span", "pill", o.status));
  for (const tag of (o.tags || []).slice(0, 3)) meta.append(el("span", "", "#" + tag));
  if (showType && o.type) meta.append(el("span", "", o.type));
  if (meta.childElementCount) body.append(meta);
  li.append(body);
  return li;
}

function render() {
  if (!view) return;
  const objects = view.objects;
  $("head").hidden = !view.title;
  $("title").textContent = view.title || "";
  $("count").textContent = objects.length > 1 ? String(objects.length) : "";
  const showType = new Set(objects.map((o) => o.type)).size > 1;
  const shown = expanded || objects.length <= FOLDED + 1 ? objects : objects.slice(0, FOLDED);
  $("list").replaceChildren(...shown.map((o) => row(o, showType)));
  const hidden = objects.length - shown.length;
  $("more").hidden = objects.length <= FOLDED + 1;
  $("more").textContent = hidden > 0 ? t().more(hidden) : t().less;
  const notes = [];
  if (!objects.length) notes.push(t().empty);
  if (view.missing?.length) notes.push(t().missing(view.missing.length));
  $("note").textContent = notes.join(" ");
  $("note").hidden = !notes.length;
}

$("more").addEventListener("click", () => { expanded = !expanded; render(); });
app.onhostcontextchanged = applyContext;
app.ontoolresult = (result) => { view = result.structuredContent || null; expanded = false; render(); };
await app.connect();
const ctx = app.getHostContext();
if (ctx) applyContext(ctx);
render();
</script>
</body></html>`;
}
