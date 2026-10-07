import { readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import path from "node:path";

for (const file of [".env.local", ".env"]) {
  try {
    loadEnvFile(file);
  } catch {
    // optional file
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const publicUrl = new URL(process.env.PUBLIC_URL ?? `http://localhost:${port}`);
const authDisabled = process.env.AUTH_DISABLED === "true";

if (authDisabled && !LOOPBACK.has(host)) {
  throw new Error("AUTH_DISABLED=true is only allowed when HOST is a loopback address");
}
if (publicUrl.protocol !== "https:" && !LOOPBACK.has(publicUrl.hostname)) {
  throw new Error("PUBLIC_URL must use https unless it points to localhost");
}

const ownerPassword = authDisabled ? "" : required("OWNER_PASSWORD");
if (!authDisabled && ownerPassword.length < 12) {
  throw new Error("OWNER_PASSWORD must be at least 12 characters");
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

/** Express "trust proxy" setting: "loopback" by default; behind Caddy in Docker use a hop count like 1. */
function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (!value) return "loopback";
  if (value === "true" || value === "false") return value === "true";
  return /^\d+$/.test(value) ? Number(value) : value;
}

export const config = {
  version: pkg.version,
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  anytypeUrl: (process.env.ANYTYPE_API_URL ?? "http://127.0.0.1:31009").replace(/\/+$/, ""),
  // API_KEY is accepted as a fallback for the original .env.local layout.
  anytypeApiKey: process.env.ANYTYPE_API_KEY?.trim() || required("API_KEY"),
  host,
  port,
  /** Public origin Claude reaches the server at (tunnel / reverse proxy URL). */
  publicUrl,
  /** The MCP endpoint, which is also the OAuth protected resource identifier. */
  mcpUrl: new URL("/mcp", publicUrl),
  // Extra hostnames allowed in the Host header, comma-separated. PUBLIC_URL's host is always allowed.
  allowedHosts: [
    publicUrl.hostname,
    ...(process.env.ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  ],
  auth: {
    disabled: authDisabled,
    ownerPassword,
    dataDir: path.resolve(process.env.DATA_DIR ?? "data"),
    accessTokenTtlSec: 60 * 60,
    refreshTokenTtlSec: 30 * 24 * 60 * 60,
    /**
     * Redirect URIs a dynamically registered client may use. Loopback URIs match on any port
     * (Claude Code uses an ephemeral one). Extend with EXTRA_REDIRECT_URIS for other MCP clients.
     */
    allowedRedirectUris: [
      "https://claude.ai/api/mcp/auth_callback",
      "https://claude.com/api/mcp/auth_callback",
      "http://localhost/callback",
      "http://127.0.0.1/callback",
      ...(process.env.EXTRA_REDIRECT_URIS ?? "")
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean),
    ],
  },
};
