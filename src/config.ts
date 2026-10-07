import { loadEnvFile } from "node:process";

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

export const config = {
  anytypeUrl: (process.env.ANYTYPE_API_URL ?? "http://127.0.0.1:31009").replace(/\/+$/, ""),
  // API_KEY is accepted as a fallback for the original .env.local layout.
  anytypeApiKey: process.env.ANYTYPE_API_KEY?.trim() || required("API_KEY"),
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  // Extra hostnames allowed in the Host header (e.g. a tunnel domain), comma-separated.
  allowedHosts: (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
};
