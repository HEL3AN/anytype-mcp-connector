const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderLoginPage(view: {
  requestId: string;
  clientName: string;
  redirectHost: string;
  error?: string;
}) {
  const client = escapeHtml(view.clientName);
  const host = escapeHtml(view.redirectHost);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Anytype</title>
<style>
  :root { --bg:#f6f6f4; --card:#fff; --text:#1d1d1b; --muted:#6b6b66; --border:#e2e2dd; --accent:#1d1d1b; --accent-text:#fff; --error:#b42318; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#151514; --card:#1f1f1d; --text:#f2f2ee; --muted:#a3a39c; --border:#34342f; --accent:#f2f2ee; --accent-text:#151514; --error:#f97066; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px;
         background:var(--bg); color:var(--text); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width:100%; max-width:400px; background:var(--card); border:1px solid var(--border); border-radius:16px; padding:28px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { margin:0 0 16px; color:var(--muted); }
  strong { color:var(--text); }
  label { display:block; font-size:14px; margin-bottom:6px; }
  input[type=password] { width:100%; padding:12px; font-size:16px; border-radius:10px; border:1px solid var(--border); background:var(--bg); color:var(--text); }
  .error { color:var(--error); font-size:14px; margin:8px 0 0; }
  .actions { display:flex; gap:12px; margin-top:20px; }
  button { flex:1; padding:12px; font-size:16px; border-radius:10px; cursor:pointer; border:1px solid var(--border); background:transparent; color:var(--text); }
  button.primary { background:var(--accent); color:var(--accent-text); border-color:var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Connect to your Anytype</h1>
  <p><strong>${client}</strong> wants to read and edit objects in your Anytype spaces. After you approve, you will be sent back to <strong>${host}</strong>.</p>
  <p>Only approve if you started this connection yourself.</p>
  <form method="post" action="/oauth/consent">
    <input type="hidden" name="request_id" value="${escapeHtml(view.requestId)}">
    <label for="password">Owner password</label>
    <input id="password" type="password" name="password" autocomplete="current-password" autofocus>
    ${view.error ? `<p class="error" role="alert">${escapeHtml(view.error)}</p>` : ""}
    <div class="actions">
      <button type="submit" name="action" value="deny" formnovalidate>Deny</button>
      <button type="submit" name="action" value="approve" class="primary">Approve</button>
    </div>
  </form>
</main>
</body>
</html>`;
}
