import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { AnytypeClient } from "./anytype/client.js";
import { config } from "./config.js";
import { registerTools } from "./tools.js";

const api = new AnytypeClient(config.anytypeUrl, config.anytypeApiKey);

function createServer() {
  const server = new McpServer(
    { name: "anytype", title: "Anytype", version: "0.1.0" },
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
// DNS-rebinding protection: only accept expected Host headers.
app.use(
  config.allowedHosts.length
    ? hostHeaderValidation(["localhost", "127.0.0.1", ...config.allowedHosts])
    : localhostHostValidation(),
);
app.use(express.json({ limit: "4mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Stateless Streamable HTTP: a fresh server + transport per request.
app.post("/mcp", async (req, res) => {
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

app.listen(config.port, config.host, () => {
  console.log(`Anytype MCP server listening on http://${config.host}:${config.port}/mcp`);
  console.log(`Anytype API: ${config.anytypeUrl}`);
});
