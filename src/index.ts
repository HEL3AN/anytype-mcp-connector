import { createApp } from "./app.js";
import { loadConfig, loadEnvFiles } from "./config.js";

loadEnvFiles();
const config = loadConfig();
const { app, close } = createApp(config);

const httpServer = app.listen(config.port, config.host, () => {
  console.log(`Anytype MCP connector v${config.version} listening on http://${config.host}:${config.port}`);
  console.log(`MCP endpoint: ${config.mcpUrl.href} (auth ${config.auth.disabled ? "DISABLED" : "OAuth"})`);
  console.log(`Anytype API: ${config.anytypeUrl}`);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  void close();
  httpServer.close(() => process.exit(0));
  httpServer.closeIdleConnections();
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
