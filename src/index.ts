import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { AnytypeClient } from "./anytype/client.js";
import { OwnerOAuthProvider } from "./auth/provider.js";
import { config } from "./config.js";
import { registerTools } from "./tools.js";

const SCOPES = ["anytype"];

const api = new AnytypeClient(config.anytypeUrl, config.anytypeApiKey);

function createServer() {
  const server = new McpServer(
    { name: "anytype", title: "Anytype", version: config.version },
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
  res.on("finish", () => {
    const rpc = req.path === "/mcp" ? describeRpc(req.body) : "";
    const ms = Math.round(performance.now() - start);
    console.log(`${req.method} ${req.path} ${res.statusCode} ${ms}ms${rpc ? ` ${rpc}` : ""}`);
  });
  next();
});

// DNS-rebinding protection: only accept expected Host headers.
app.use(hostHeaderValidation(["localhost", "127.0.0.1", "[::1]", ...config.allowedHosts]));

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

// Stateless Streamable HTTP: a fresh server + transport per request.
app.post("/mcp", ...mcpMiddleware, async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
});

const methodNotAllowed: express.RequestHandler = (_req, res) => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const httpServer = app.listen(config.port, config.host, () => {
  console.log(`Anytype MCP connector v${config.version} listening on http://${config.host}:${config.port}`);
  console.log(`MCP endpoint: ${config.mcpUrl.href} (auth ${config.auth.disabled ? "DISABLED" : "OAuth"})`);
  console.log(`Anytype API: ${config.anytypeUrl}`);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
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
