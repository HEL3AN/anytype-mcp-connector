const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
  :root { --bg:#f6f6f4; --card:#fff; --text:#1d1d1b; --muted:#6b6b66; --border:#e2e2dd; --accent:#1d1d1b; --accent-text:#fff; --error:#b42318; --warn-bg:#fff7e6; --warn:#8a5a00; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#151514; --card:#1f1f1d; --text:#f2f2ee; --muted:#a3a39c; --border:#34342f; --accent:#f2f2ee; --accent-text:#151514; --error:#f97066; --warn-bg:#2e2410; --warn:#f5c26b; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px;
         background:var(--bg); color:var(--text); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width:100%; max-width:400px; background:var(--card); border:1px solid var(--border); border-radius:16px; padding:28px; }
  .logo { display:block; width:48px; height:48px; border-radius:12px; margin-bottom:16px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { margin:0 0 16px; color:var(--muted); }
  strong { color:var(--text); overflow-wrap:anywhere; }
  .badge { display:inline-block; font-size:12px; padding:1px 8px; border-radius:999px; border:1px solid var(--border); color:var(--muted); margin-left:4px; }
  .warn { background:var(--warn-bg); color:var(--warn); border-radius:10px; padding:10px 12px; font-size:14px; }
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
  <img class="logo" src="/icon-128.png" alt="" width="48" height="48">
${body}
</main>
</body>
</html>`;
}

export function renderLoginPage(view: {
  requestId: string;
  clientName: string;
  /** True when the client identity was verified (fetched from its metadata URL). */
  verified: boolean;
  redirectHost: string;
  /** All redirect URIs are on this machine: any local program could claim to be the client. */
  localhostOnly: boolean;
  error?: string;
}) {
  const client = escapeHtml(view.clientName);
  const host = escapeHtml(view.redirectHost);
  const badge = view.verified ? "" : `<span class="badge">self-declared name</span>`;
  const warning = view.localhostOnly
    ? `<p class="warn">This app receives access on this computer (<strong>${host}</strong>). Any local program can claim to be it — approve only if you just started it yourself.</p>`
    : "";
  return layout(
    "Connect Anytype",
    `  <h1>Connect to your Anytype</h1>
  <p><strong>${client}</strong>${badge} wants to read and edit objects in your Anytype spaces. After you approve, you will be sent back to <strong>${host}</strong>.</p>
  ${warning}
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
  </form>`,
  );
}

/** Shown when the request can't be redirected back safely (unknown client, bad redirect_uri, expired). */
export function renderErrorPage(message: string) {
  return layout(
    "Connection error",
    `  <h1>Can't connect</h1>
  <p>${escapeHtml(message)}</p>
  <p>Close this page and start the connection again from Claude.</p>`,
  );
}
