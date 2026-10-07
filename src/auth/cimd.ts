// Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document), as required by
// MCP 2026-07-28: a client_id that is an HTTPS URL names a JSON document describing the client.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ClientMetadataDocument {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
  client_uri?: string;
  logo_uri?: string;
}

export class CimdError extends Error {}

const MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** True when a client_id should be resolved as a metadata document URL. */
export function isCimdClientId(clientId: string): boolean {
  return clientId.startsWith("https://");
}

/**
 * Fetches and validates client metadata documents, with SSRF hardening and caching.
 * `trustedHosts` limits which hosts may serve documents ("*" allows any public host).
 */
export class CimdResolver {
  private readonly cache = new Map<string, { doc: ClientMetadataDocument; expiresAt: number }>();

  constructor(
    private readonly trustedHosts: string[],
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly resolveHost: (host: string) => Promise<string[]> = resolvePublicAddresses,
  ) {}

  async resolve(clientId: string): Promise<ClientMetadataDocument> {
    const cached = this.cache.get(clientId);
    if (cached && cached.expiresAt > Date.now()) return cached.doc;

    const url = this.checkUrl(clientId);
    await this.resolveHost(url.hostname);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        redirect: "manual", // a redirect could point anywhere; the spec requires the exact URL
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new CimdError(`could not fetch client metadata: ${err instanceof Error ? err.message : err}`);
    }
    if (res.status !== 200) throw new CimdError(`client metadata URL answered ${res.status}`);

    const doc = validateDocument(clientId, await readJson(res));
    this.cache.set(clientId, { doc, expiresAt: Date.now() + cacheTtl(res.headers.get("cache-control")) });
    return doc;
  }

  private checkUrl(clientId: string): URL {
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      throw new CimdError("client_id is not a valid URL");
    }
    if (url.protocol !== "https:") throw new CimdError("client_id URL must use https");
    if (url.pathname === "/" || url.pathname === "") throw new CimdError("client_id URL must have a path");
    if (url.username || url.password || url.hash) throw new CimdError("client_id URL must not contain credentials or a fragment");
    if (url.port && url.port !== "443") throw new CimdError("client_id URL must use the default https port");
    if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) throw new CimdError("client_id URL must use a host name, not an IP address");
    if (!this.trustedHosts.includes("*") && !this.trustedHosts.includes(url.hostname)) {
      throw new CimdError(`client metadata host ${url.hostname} is not trusted by this server`);
    }
    return url;
  }
}

function validateDocument(clientId: string, raw: unknown): ClientMetadataDocument {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CimdError("client metadata is not a JSON object");
  const doc = raw as Record<string, unknown>;
  if (doc.client_id !== clientId) throw new CimdError("client metadata client_id does not match its URL");
  if (typeof doc.client_name !== "string" || !doc.client_name.trim()) throw new CimdError("client metadata lacks client_name");
  const redirects = doc.redirect_uris;
  if (!Array.isArray(redirects) || !redirects.length || !redirects.every((u) => typeof u === "string" && URL.canParse(u))) {
    throw new CimdError("client metadata redirect_uris must be a non-empty list of URLs");
  }
  const authMethod = doc.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== "none") {
    throw new CimdError("only public clients (token_endpoint_auth_method none) are supported");
  }
  for (const secretField of ["client_secret", "client_secret_expires_at"]) {
    if (secretField in doc) throw new CimdError(`client metadata must not contain ${secretField}`);
  }
  return {
    client_id: clientId,
    client_name: doc.client_name.trim().slice(0, 200),
    redirect_uris: redirects as string[],
    token_endpoint_auth_method: "none",
    client_uri: typeof doc.client_uri === "string" ? doc.client_uri : undefined,
    logo_uri: typeof doc.logo_uri === "string" ? doc.logo_uri : undefined,
  };
}

async function readJson(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new CimdError("client metadata document is too large");
  const reader = res.body?.getReader();
  if (!reader) throw new CimdError("client metadata response has no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new CimdError("client metadata document is too large");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CimdError("client metadata is not valid JSON");
  }
}

function cacheTtl(cacheControl: string | null): number {
  if (!cacheControl) return DEFAULT_TTL_MS;
  if (/no-store|no-cache/i.test(cacheControl)) return MIN_TTL_MS;
  const maxAge = /max-age=(\d+)/i.exec(cacheControl);
  if (!maxAge) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(maxAge[1]) * 1000));
}

/** Resolves a host and refuses loopback, private, link-local and other non-public addresses (SSRF). */
export async function resolvePublicAddresses(host: string): Promise<string[]> {
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new CimdError(`cannot resolve ${host}`);
  }
  for (const { address } of addresses) {
    if (!isPublicAddress(address)) throw new CimdError(`${host} resolves to a non-public address`);
  }
  return addresses.map((a) => a.address);
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPublicAddress(v6.slice(7));
  return !(
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb") ||
    v6.startsWith("ff")
  );
}
