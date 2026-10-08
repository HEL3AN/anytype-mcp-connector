// Shared test helpers: a fake Anytype JSON API, a test config, and a way to run an Express app.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Express } from "express";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config.js";

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A local HTTP server standing in for the Anytype API. Records every request. */
export async function fakeAnytype(handler: (req: RecordedRequest) => FakeReply | undefined = () => undefined) {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://anytype");
      const text = Buffer.concat(chunks).toString("utf8");
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      requests.push(recorded);
      const reply = handler(recorded) ?? {};
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json", ...reply.headers });
      res.end(JSON.stringify(reply.body ?? { data: [] }));
    });
  });
  const url = await listenOn(server);
  return { url, requests, close: () => closeServer(server) };
}

/** A temporary data directory, removed by the returned cleanup function. */
export function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "anytype-mcp-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Config for tests: loopback, test API key, temp data dir; override any env variable. */
export function testConfig(env: Record<string, string | undefined> = {}) {
  return loadConfig({
    HOST: "127.0.0.1",
    PORT: "3000",
    API_KEY: "test-key",
    OWNER_PASSWORD: "correct horse battery",
    ...env,
  });
}

/** Serves an Express app on an ephemeral loopback port. */
export async function serve(app: Express) {
  const server = createServer(app);
  const url = await listenOn(server);
  return { url, close: () => closeServer(server) };
}

/** MCP client connected to `url`, optionally with a bearer token. */
export async function mcpClient(url: string, token?: string) {
  const client = new Client({ name: "test", version: "0.0.0" });
  const requestInit = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit }));
  return client;
}

/** Text of the first content item of a tool result. */
export function resultText(res: { content?: unknown }): string {
  return ((res.content as { type: string; text?: string }[] | undefined)?.[0]?.text) ?? "";
}

async function listenOn(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function closeServer(server: Server) {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}
