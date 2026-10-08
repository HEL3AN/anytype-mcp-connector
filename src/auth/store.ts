import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** A client registered through Dynamic Client Registration (RFC 7591). */
export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  client_secret?: string;
  /** 0 = never expires */
  client_secret_expires_at?: number;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
}

export interface RefreshTokenRecord {
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number; // unix seconds
  /** All refresh tokens descending from one authorization share a family. */
  family: string;
}

interface StoreData {
  clients: Record<string, RegisteredClient>;
  /** sha256(refresh token) -> record */
  refreshTokens: Record<string, RefreshTokenRecord>;
  /** sha256 of already-rotated refresh tokens -> family; reuse revokes the family. */
  rotatedTokens: Record<string, { family: string; expiresAt: number }>;
  /** Revoked families -> until when (unix seconds) their access tokens must be refused. */
  revokedFamilies: Record<string, number>;
}

/** DCR clients that never obtained a token are dropped after this long (registration spam). */
const UNUSED_CLIENT_TTL_SEC = 24 * 60 * 60;

/** Small JSON-file store for OAuth state. Single-process; writes are atomic (tmp + rename). */
export class AuthStore {
  private data: StoreData;
  private readonly file: string;
  readonly signingKey: Buffer;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "oauth.json");
    this.data = { clients: {}, refreshTokens: {}, rotatedTokens: {}, revokedFamilies: {}, ...readJson<Partial<StoreData>>(this.file) };

    const keyFile = path.join(dir, "signing.key");
    const existing = readFileOrNull(keyFile);
    if (existing) {
      this.signingKey = Buffer.from(existing.trim(), "base64");
    } else {
      this.signingKey = randomBytes(32);
      writeFileSync(keyFile, this.signingKey.toString("base64"), { mode: 0o600 });
    }
    this.flush();
  }

  getClient(id: string) {
    return this.data.clients[id];
  }

  clientCount() {
    return Object.keys(this.data.clients).length;
  }

  saveClient(client: RegisteredClient) {
    this.data.clients[client.client_id] = client;
    this.flush();
  }

  getRefreshToken(hash: string) {
    return this.data.refreshTokens[hash];
  }

  saveRefreshToken(hash: string, record: RefreshTokenRecord) {
    this.data.refreshTokens[hash] = record;
    this.flush();
  }

  /** Removes a refresh token, remembering it so a replay can be detected. */
  rotateRefreshToken(hash: string) {
    const record = this.data.refreshTokens[hash];
    if (!record) return;
    delete this.data.refreshTokens[hash];
    this.data.rotatedTokens[hash] = { family: record.family, expiresAt: record.expiresAt };
    this.flush();
  }

  rotatedFamily(hash: string) {
    return this.data.rotatedTokens[hash]?.family;
  }

  /** Revokes all refresh tokens of a family; its access tokens are refused until `accessUntil`. */
  revokeFamily(family: string, accessUntil: number) {
    for (const [hash, rec] of Object.entries(this.data.refreshTokens)) {
      if (rec.family === family) delete this.data.refreshTokens[hash];
    }
    this.data.revokedFamilies[family] = Math.max(this.data.revokedFamilies[family] ?? 0, accessUntil);
    this.flush();
  }

  isFamilyRevoked(family: string) {
    return (this.data.revokedFamilies[family] ?? 0) > Date.now() / 1000;
  }

  deleteRefreshToken(hash: string) {
    delete this.data.refreshTokens[hash];
    this.flush();
  }

  /** Drops expired records and DCR clients that never obtained a token. Runs on every write. */
  private prune() {
    const now = Date.now() / 1000;
    for (const [hash, rec] of Object.entries(this.data.refreshTokens)) {
      if (rec.expiresAt < now) delete this.data.refreshTokens[hash];
    }
    for (const [hash, rec] of Object.entries(this.data.rotatedTokens)) {
      if (rec.expiresAt < now) delete this.data.rotatedTokens[hash];
    }
    for (const [family, until] of Object.entries(this.data.revokedFamilies)) {
      if (until < now) delete this.data.revokedFamilies[family];
    }
    const withTokens = new Set(Object.values(this.data.refreshTokens).map((r) => r.clientId));
    for (const [id, client] of Object.entries(this.data.clients)) {
      if (!withTokens.has(id) && client.client_id_issued_at + UNUSED_CLIENT_TTL_SEC < now) delete this.data.clients[id];
    }
  }

  private flush() {
    this.prune();
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

function readFileOrNull(file: string) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson<T>(file: string): T | null {
  const text = readFileOrNull(file);
  return text ? (JSON.parse(text) as T) : null;
}
