import { fileURLToPath } from "node:url";
import express from "express";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
// The v2 SDK only ships resource-server helpers; the OAuth authorization server still comes from v1.
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { AnytypeClient } from "./anytype/client.js";
import { OwnerOAuthProvider } from "./auth/provider.js";
import { config } from "./config.js";
import { renderLandingPage } from "./landing-page.js";
import { registerTools } from "./tools.js";

const SCOPES = ["anytype"];

const api = new AnytypeClient(config.anytypeUrl, config.anytypeApiKey);

function createServer() {
  const server = new McpServer(
    {
      name: "anytype",
      title: "Anytype",
      version: config.version,
      websiteUrl: config.publicUrl.href,
      icons: [
        { src: new URL("/icon.svg", config.publicUrl).href, mimeType: "image/svg+xml", sizes: ["any"] },
        { src: new URL("/icon-128.png", config.publicUrl).href, mimeType: "image/png", sizes: ["128x128"] },
      ],
    },
    {
      instructions:
        "Tools for the user's Anytype workspace (a local-first, end-to-end encrypted knowledge base). " +
        "Start with anytype_search or anytype_list_spaces, read with anytype_fetch, " +
        "edit with anytype_edit_object (prefer replace_text / insert_blocks with markdown).",
    },
  );
  registerTools(server, api);
  return server;
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy);

// One line per request: no query strings or bodies (they can carry codes, tokens and user content).
app.use((req, res, next) => {
  const start = performance.now();
  // Capture now: nested routers rewrite req.url/req.path to their mount-relative form.
  const path = req.originalUrl.split("?")[0];
  res.on("finish", () => {
    const rpc = path === "/mcp" ? describeRpc(req.body) : "";
    const ms = Math.round(performance.now() - start);
    console.log(`${req.method} ${path} ${res.statusCode} ${ms}ms${rpc ? ` ${rpc}` : ""}`);
  });
  next();
});

// DNS-rebinding protection: only accept expected Host headers.
app.use(hostHeaderValidation(["localhost", "127.0.0.1", "[::1]", ...config.allowedHosts]));

// Icons (favicon.ico, icon.svg, icon-128.png) used by Claude and browsers to show the connector.
app.use(
  express.static(fileURLToPath(new URL("../public/", import.meta.url)), {
    index: false,
    maxAge: "7d",
  }),
);

const landingPage = renderLandingPage({
  mcpUrl: config.mcpUrl.href,
  iconUrl: new URL("/icon-128.png", config.publicUrl).href,
  version: config.version,
});
app.get("/", (_req, res) => {
  res
    .set({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'",
      "Cache-Control": "public, max-age=3600",
    })
    .type("html")
    .send(landingPage);
});

// Let crawlers index the home page (and its icon) but nothing else.
app.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send("User-agent: *\nAllow: /$\nAllow: /favicon.ico\nAllow: /icon\nDisallow: /\n");
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, version: config.version });
});

// Readiness: Anytype is reachable and the API key is accepted.
app.get("/readyz", async (_req, res) => {
  try {
    const { data } = await api.get<{ key_status?: string; grant?: { spaces?: unknown[]; all_spaces?: boolean } }>(
      "/v2/auth/whoami",
    );
    res.json({
      ok: true,
      version: config.version,
      anytype: { key_status: data.key_status, spaces: data.grant?.all_spaces ? "all" : (data.grant?.spaces?.length ?? 0) },
    });
  } catch (err) {
    res.status(503).json({ ok: false, version: config.version, error: err instanceof Error ? err.message : String(err) });
  }
});

const mcpMiddleware: express.RequestHandler[] = [express.json({ limit: "4mb" })];

if (!config.auth.disabled) {
  const provider = new OwnerOAuthProvider({
    dataDir: config.auth.dataDir,
    ownerPassword: config.auth.ownerPassword,
    resource: config.mcpUrl,
    scopes: SCOPES,
    accessTokenTtlSec: config.auth.accessTokenTtlSec,
    refreshTokenTtlSec: config.auth.refreshTokenTtlSec,
    allowedRedirectUris: config.auth.allowedRedirectUris,
  });

  // /authorize, /token, /register, /revoke and the RFC 8414 / RFC 9728 metadata documents.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicUrl,
      resourceServerUrl: config.mcpUrl,
      scopesSupported: SCOPES,
      resourceName: "Anytype",
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );
  app.use("/oauth/consent", provider.consentRouter());

  mcpMiddleware.unshift(
    requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl),
      expectedResource: config.mcpUrl,
    }),
  );
} else {
  console.warn("WARNING: AUTH_DISABLED=true — /mcp accepts unauthenticated requests (loopback only).");
}

// Serves the 2026-07-28 protocol (server/discover, per-request envelopes) and, statelessly,
// 2025-era clients that still initialize. A fresh server instance handles each request.
const mcpHandler = createMcpHandler(createServer, {
  legacy: "stateless",
  onerror: (err) => console.error("MCP error:", err.message),
});
const nodeMcpHandler = toNodeHandler(mcpHandler, {
  onerror: (err) => console.error("MCP request failed:", err),
});
app.all("/mcp", ...mcpMiddleware, (req, res) => nodeMcpHandler(req, res, req.body));

const httpServer = app.listen(config.port, config.host, () => {
  console.log(`Anytype MCP connector v${config.version} listening on http://${config.host}:${config.port}`);
  console.log(`MCP endpoint: ${config.mcpUrl.href} (auth ${config.auth.disabled ? "DISABLED" : "OAuth"})`);
  console.log(`Anytype API: ${config.anytypeUrl}`);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  void mcpHandler.close();
  httpServer.close(() => process.exit(0));
  httpServer.closeIdleConnections();
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function describeRpc(body: unknown): string {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs
    .map((m) => {
      if (!m || typeof m !== "object" || !("method" in m)) return "";
      const { method, params } = m as { method: string; params?: { name?: unknown } };
      return method === "tools/call" && typeof params?.name === "string" ? `${method}:${params.name}` : method;
    })
    .filter(Boolean)
    .join(",");
}
