const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Public home page: lets browsers and favicon crawlers find the icon, and tells visitors what this is. */
export function renderLandingPage(view: { mcpUrl: string; iconUrl: string; version: string }) {
  const mcpUrl = escapeHtml(view.mcpUrl);
  const iconUrl = escapeHtml(view.iconUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Anytype for Claude</title>
<meta name="description" content="Self-hosted MCP connector that lets Claude search, read and edit your Anytype workspace.">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon-128.png">
<meta property="og:title" content="Anytype for Claude">
<meta property="og:description" content="Self-hosted MCP connector for your Anytype workspace.">
<meta property="og:image" content="${iconUrl}">
<style>
  :root { --bg:#f6f6f4; --card:#fff; --text:#1d1d1b; --muted:#6b6b66; --border:#e2e2dd; --code:#efefeb; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#151514; --card:#1f1f1d; --text:#f2f2ee; --muted:#a3a39c; --border:#34342f; --code:#2a2a27; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px;
         background:var(--bg); color:var(--text); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width:100%; max-width:440px; background:var(--card); border:1px solid var(--border); border-radius:16px; padding:28px; }
  img { display:block; width:56px; height:56px; border-radius:14px; margin-bottom:16px; }
  h1 { font-size:22px; margin:0 0 8px; }
  p { margin:0 0 16px; color:var(--muted); }
  code { display:block; padding:10px 12px; border-radius:10px; background:var(--code); color:var(--text);
         font:14px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap:anywhere; }
  small { display:block; margin-top:16px; color:var(--muted); }
</style>
</head>
<body>
<main>
  <img src="/icon-128.png" alt="Anytype" width="56" height="56">
  <h1>Anytype for Claude</h1>
  <p>A self-hosted MCP connector that lets Claude search, read and edit this Anytype workspace.</p>
  <p>To connect, add a custom connector in Claude (Settings → Connectors) with this URL:</p>
  <code>${mcpUrl}</code>
  <small>v${escapeHtml(view.version)}</small>
</main>
</body>
</html>`;
}
