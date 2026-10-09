// Single-owner OAuth 2.1 authorization server for the MCP endpoint (MCP authorization 2026-07-28):
// Client ID Metadata Documents (preferred) and Dynamic Client Registration (deprecated, kept for
// compatibility), S256 PKCE, RFC 9207 `iss`, RFC 8707 resource binding, rotating refresh tokens.
// Every authorization is approved by the owner on a consent page with the owner password.
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import express, { type Request, type RequestHandler, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { CimdError, CimdResolver, isCimdClientId } from "./cimd.js";
import { canWrite, normalizeScopes, READ_SCOPE } from "./scopes.js";
import { renderErrorPage, renderLoginPage } from "./login-page.js";
import { AuthStore, type RegisteredClient } from "./store.js";

export interface OAuthServerOptions {
  /** Issuer identifier; also the base for endpoint URLs. */
  issuer: URL;
  /** Canonical resource (the MCP endpoint URL); tokens are bound to it. */
  resource: URL;
  dataDir: string;
  ownerPassword: string;
  scopes: string[];
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  /** Redirect URIs any client may use; loopback entries match on any port. */
  allowedRedirectUris: string[];
  /** Hosts allowed to serve client metadata documents ("*" = any public host). */
  cimdTrustedHosts: string[];
  /** Overrides the metadata document resolver (tests). */
  cimdResolver?: CimdResolver;
  maxClients?: number;
}

export interface AuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource: URL;
}

/** A client as seen by the endpoints, whichever way it was registered. */
interface Client {
  id: string;
  kind: "cimd" | "dcr";
  name: string;
  /** What the consent page names as the requesting app. */
  displayName: string;
  verified: boolean;
  redirectUris: string[];
  secret?: string;
  secretExpiresAt?: number;
}

interface PendingAuthorization {
  client: Client;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

interface AuthorizationCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const PENDING_TTL_MS = 10 * 60 * 1000;
/** Most authorization requests waiting for consent at once; the oldest are dropped beyond it. */
const MAX_PENDING = 1000;
const CODE_TTL_MS = 60 * 1000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
/** Per-process key for constant-time comparison of secrets (the digest is never stored). */
const COMPARE_KEY = randomBytes(32);
const sha256hex = (value: string) => createHash("sha256").update(value).digest("hex");
const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");
const nowSec = () => Math.floor(Date.now() / 1000);
const normResource = (s: string) => s.split("#")[0]!.replace(/\/$/, "");

/** Exact match, except loopback redirect URIs match on any port (RFC 8252 §7.3). */
export function redirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  let req: URL;
  let reg: URL;
  try {
    req = new URL(requested);
    reg = new URL(registered);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(req.hostname) || !LOOPBACK_HOSTS.has(reg.hostname)) return false;
  return (
    req.protocol === reg.protocol &&
    req.hostname === reg.hostname &&
    req.pathname === reg.pathname &&
    req.search === reg.search
  );
}

/** Verifies an S256 PKCE pair. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

export class OAuthServer {
  private readonly store: AuthStore;
  private readonly cimd: CimdResolver;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  /** scrypt of the owner password with a per-process salt: each guess costs real work. */
  private readonly passwordHash: Promise<Buffer>;
  private readonly passwordSalt = randomBytes(16);
  private readonly issuer: string;

  constructor(private readonly opts: OAuthServerOptions) {
    this.store = new AuthStore(opts.dataDir);
    this.cimd = opts.cimdResolver ?? new CimdResolver(opts.cimdTrustedHosts);
    this.passwordHash = scryptAsync(opts.ownerPassword, this.passwordSalt, 32);
    this.issuer = opts.issuer.href;
  }

  get protectedResourceMetadataUrl(): string {
    const path = this.opts.resource.pathname === "/" ? "" : this.opts.resource.pathname;
    return new URL(`/.well-known/oauth-protected-resource${path}`, this.opts.resource).href;
  }

  authorizationServerMetadata() {
    const url = (p: string) => new URL(p, this.opts.issuer).href;
    return {
      issuer: this.issuer,
      authorization_endpoint: url("/authorize"),
      token_endpoint: url("/token"),
      registration_endpoint: url("/register"),
      revocation_endpoint: url("/revoke"),
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: this.opts.scopes,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  protectedResourceMetadata() {
    return {
      resource: this.opts.resource.href,
      authorization_servers: [this.issuer],
      scopes_supported: this.opts.scopes,
      bearer_methods_supported: ["header"],
      resource_name: "Anytype",
    };
  }

  /** All authorization-server and metadata routes. Mount at the app root. */
  router(): express.Router {
    const router = express.Router();
    const publicCors: RequestHandler = (req, res, next) => {
      res.set({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
      });
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    };
    const limiter = (windowMin: number, limit: number) =>
      rateLimit({ windowMs: windowMin * 60_000, limit, standardHeaders: true, legacyHeaders: false });

    const metadataLimiter = limiter(1, 300);
    router.use("/.well-known/oauth-authorization-server", metadataLimiter, publicCors, (_req, res) => {
      res.json(this.authorizationServerMetadata());
    });
    const resourcePath = this.opts.resource.pathname === "/" ? "" : this.opts.resource.pathname;
    for (const path of new Set([`/.well-known/oauth-protected-resource${resourcePath}`, "/.well-known/oauth-protected-resource"])) {
      router.use(path, metadataLimiter, publicCors, (_req, res) => {
        res.json(this.protectedResourceMetadata());
      });
    }

    const urlencoded = express.urlencoded({ extended: false, limit: "64kb" });
    router.all("/authorize", limiter(15, 100), urlencoded, (req, res) => void this.authorize(req, res));
    // Brute-force guard: only failed attempts (wrong password, expired request) count, per IP and
    // across all IPs (an attacker with many addresses still gets few guesses).
    const consentLimiter = rateLimit({
      windowMs: 15 * 60_000,
      limit: 10,
      skipSuccessfulRequests: true,
      standardHeaders: true,
      legacyHeaders: false,
    });
    const globalConsentLimiter = rateLimit({
      windowMs: 60 * 60_000,
      limit: 30,
      skipSuccessfulRequests: true,
      keyGenerator: () => "all",
      standardHeaders: true,
      legacyHeaders: false,
    });
    router.post("/oauth/consent", consentLimiter, globalConsentLimiter, urlencoded, (req, res) => void this.consent(req, res));
    router.options(["/token", "/register", "/revoke"], publicCors);
    router.post("/token", publicCors, limiter(1, 60), urlencoded, (req, res) => void this.token(req, res));
    router.post("/register", publicCors, limiter(60, 20), express.json({ limit: "64kb" }), (req, res) =>
      this.register(req, res),
    );
    router.post("/revoke", publicCors, limiter(1, 60), urlencoded, (req, res) => void this.revoke(req, res));
    return router;
  }

  /** Bearer-token middleware for the protected resource. */
  bearer(): RequestHandler {
    return async (req, res, next) => {
      const challenge = (error?: string, description?: string) => {
        const parts = [`resource_metadata="${this.protectedResourceMetadataUrl}"`, `scope="${this.opts.scopes.join(" ")}"`];
        if (error) parts.unshift(`error="${error}"`, `error_description="${description}"`);
        res.set("WWW-Authenticate", `Bearer ${parts.join(", ")}`);
        res.status(401).json({ error: error ?? "invalid_token", error_description: description ?? "Missing access token" });
      };
      const header = req.headers.authorization;
      if (!header) return challenge();
      const [scheme, token] = header.split(" ");
      if (scheme?.toLowerCase() !== "bearer" || !token) return challenge("invalid_request", "Expected a Bearer token");
      try {
        (req as Request & { auth?: AuthInfo }).auth = await this.verifyAccessToken(token);
        next();
      } catch (err) {
        challenge("invalid_token", err instanceof Error ? err.message : "Invalid access token");
      }
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const [payloadPart, sig] = token.split(".");
    if (!payloadPart || !sig) throw new Error("Malformed access token");
    const a = Buffer.from(sig);
    const b = Buffer.from(this.sign(payloadPart));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Invalid access token");
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
      cid: string;
      scp: string[];
      aud: string;
      exp: number;
      fam?: string;
    };
    if (payload.exp < nowSec()) throw new Error("Access token expired");
    if (payload.fam && this.store.isFamilyRevoked(payload.fam)) throw new Error("Access token was revoked");
    if (normResource(payload.aud) !== normResource(this.opts.resource.href)) throw new Error("Token was not issued for this resource");
    if (!isCimdClientId(payload.cid) && !this.store.getClient(payload.cid)) throw new Error("Client no longer registered");
    return { token, clientId: payload.cid, scopes: normalizeScopes(payload.scp), expiresAt: payload.exp, resource: new URL(payload.aud) };
  }

  // --- /authorize -------------------------------------------------------------------------

  private async authorize(req: Request, res: Response) {
    res.set("Cache-Control", "no-store");
    const p = { ...(req.query as Record<string, unknown>), ...((req.method === "POST" ? req.body : {}) as Record<string, unknown>) };
    const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);

    // Until the client and redirect URI are validated, errors are shown here, never redirected.
    let client: Client;
    let redirectUri: string;
    try {
      const clientId = str("client_id");
      if (!clientId) throw new OAuthError("invalid_request", "client_id is required");
      client = await this.resolveClient(clientId);
      redirectUri = this.pickRedirectUri(client, str("redirect_uri"));
    } catch (err) {
      sendHtml(res.status(400), renderErrorPage(err instanceof Error ? err.message : String(err)));
      return;
    }

    const state = str("state");
    const fail = (code: string, description: string) => this.redirectWith(res, redirectUri, { error: code, error_description: description, state });

    if (str("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
    const codeChallenge = str("code_challenge");
    if (!codeChallenge || str("code_challenge_method") !== "S256") {
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    const resource = str("resource") ?? this.opts.resource.href;
    if (normResource(resource) !== normResource(this.opts.resource.href)) {
      return fail("invalid_target", "resource must be this server's MCP endpoint");
    }
    const scopes = normalizeScopes((str("scope") ?? "").split(" ").filter(Boolean)).filter((s) => this.opts.scopes.includes(s));

    this.sweep();
    for (const id of this.pending.keys()) {
      if (this.pending.size < MAX_PENDING) break;
      this.pending.delete(id); // oldest first (insertion order)
    }
    const requestId = randomUUID();
    const pending = {
      client,
      redirectUri,
      codeChallenge,
      state,
      scopes: scopes.length ? scopes : this.opts.scopes,
      resource,
      expiresAt: Date.now() + PENDING_TTL_MS,
    };
    this.pending.set(requestId, pending);
    sendHtml(res, renderLoginPage(this.consentView(requestId, client, redirectUri, pending.scopes)));
  }

  private async consent(req: Request, res: Response) {
    res.set("Cache-Control", "no-store");
    const { request_id, password, action, access } = req.body as Record<string, string | undefined>;
    const pending = request_id ? this.pending.get(request_id) : undefined;
    if (!pending || pending.expiresAt < Date.now()) {
      sendHtml(res.status(400), renderErrorPage("This sign-in request has expired. Start again from Claude."));
      return;
    }
    if (action !== "approve") {
      this.pending.delete(request_id!);
      this.redirectWith(res, pending.redirectUri, { error: "access_denied", error_description: "The owner denied access", state: pending.state });
      return;
    }
    if (!(await this.checkPassword(password ?? ""))) {
      console.warn("Consent: wrong owner password");
      const view = this.consentView(request_id!, pending.client, pending.redirectUri, pending.scopes);
      sendHtml(res.status(401), renderLoginPage({ ...view, readOnlyChosen: access === "read", error: "Wrong password" }));
      return;
    }
    this.pending.delete(request_id!);
    const code = b64url(randomBytes(32));
    this.codes.set(code, {
      clientId: pending.client.id,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      // The owner may narrow the request to read-only on the consent page (never widen it).
      scopes: access === "read" ? pending.scopes.filter((s) => s === READ_SCOPE) : pending.scopes,
      resource: pending.resource,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    this.redirectWith(res, pending.redirectUri, { code, state: pending.state });
  }

  private consentView(requestId: string, client: Client, redirectUri: string, scopes: string[]) {
    return {
      requestId,
      canWrite: canWrite(scopes),
      clientName: client.displayName,
      verified: client.verified,
      redirectHost: new URL(redirectUri).host,
      localhostOnly: client.redirectUris.every((u) => LOOPBACK_HOSTS.has(new URL(u).hostname)),
    };
  }

  /** Redirects to the client with RFC 9207 `iss` on every authorization response. */
  private redirectWith(res: Response, redirectUri: string, params: Record<string, string | undefined>) {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    url.searchParams.set("iss", this.issuer);
    res.redirect(302, url.href);
  }

  private pickRedirectUri(client: Client, requested: string | undefined): string {
    if (!requested) {
      if (client.redirectUris.length !== 1) throw new OAuthError("invalid_request", "redirect_uri is required");
      requested = client.redirectUris[0]!;
    }
    if (!client.redirectUris.some((r) => redirectUriMatches(requested!, r))) {
      throw new OAuthError("invalid_request", "redirect_uri is not registered for this client");
    }
    if (!this.redirectAllowed(requested)) {
      throw new OAuthError("invalid_request", `redirect_uri ${requested} is not allowed by this server`);
    }
    return requested;
  }

  private redirectAllowed(uri: string) {
    return this.opts.allowedRedirectUris.some((allowed) => redirectUriMatches(uri, allowed));
  }

  // --- clients ----------------------------------------------------------------------------

  private async resolveClient(clientId: string): Promise<Client> {
    if (isCimdClientId(clientId)) {
      try {
        const doc = await this.cimd.resolve(clientId);
        return {
          id: clientId,
          kind: "cimd",
          name: doc.client_name,
          // The document is self-asserted; the host serving it is what we can vouch for.
          displayName: `${doc.client_name} (${new URL(clientId).hostname})`,
          verified: true,
          redirectUris: doc.redirect_uris,
        };
      } catch (err) {
        const reason = err instanceof CimdError ? err.message : "metadata unavailable";
        // Logged for operators: the client_id URL is public, and this is the first thing to check
        // when a new client (or a Claude surface with a new metadata host) can't connect.
        console.warn(`CIMD client rejected: ${JSON.stringify(clientId.slice(0, 300))} — ${reason}`);
        throw new OAuthError("invalid_client", `Client metadata rejected: ${reason}`);
      }
    }
    const reg = this.store.getClient(clientId);
    if (!reg) throw new OAuthError("invalid_client", "Unknown client_id");
    return {
      id: reg.client_id,
      kind: "dcr",
      name: reg.client_name ?? reg.client_id,
      displayName: reg.client_name ?? "Unnamed client",
      verified: false,
      redirectUris: reg.redirect_uris,
      secret: reg.client_secret,
      secretExpiresAt: reg.client_secret_expires_at,
    };
  }

  /** Client authentication at the token and revocation endpoints. */
  private async authenticateClient(req: Request): Promise<Client> {
    let clientId = typeof req.body?.client_id === "string" ? (req.body.client_id as string) : undefined;
    let secret = typeof req.body?.client_secret === "string" ? (req.body.client_secret as string) : undefined;
    const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? "");
    if (basic) {
      const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
      const i = decoded.indexOf(":");
      if (i < 0) throw new OAuthError("invalid_client", "Malformed Basic credentials", 401);
      try {
        clientId = decodeURIComponent(decoded.slice(0, i));
        secret = decodeURIComponent(decoded.slice(i + 1));
      } catch {
        throw new OAuthError("invalid_client", "Malformed Basic credentials", 401);
      }
    }
    if (!clientId) throw new OAuthError("invalid_client", "client_id is required", 401);
    let client: Client;
    try {
      client = await this.resolveClient(clientId);
    } catch {
      throw new OAuthError("invalid_client", "Unknown client", 401);
    }
    if (client.secret) {
      if (!secret || !safeEqual(secret, client.secret)) throw new OAuthError("invalid_client", "Invalid client credentials", 401);
      if (client.secretExpiresAt && client.secretExpiresAt < nowSec()) throw new OAuthError("invalid_client", "Client secret expired", 401);
    }
    return client;
  }

  private register(req: Request, res: Response) {
    res.set("Cache-Control", "no-store");
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const redirectUris = body.redirect_uris;
      if (!Array.isArray(redirectUris) || !redirectUris.length || !redirectUris.every((u) => typeof u === "string" && URL.canParse(u))) {
        throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a non-empty list of URLs");
      }
      for (const uri of redirectUris as string[]) {
        if (!this.redirectAllowed(uri)) throw new OAuthError("invalid_redirect_uri", `redirect_uri not allowed by this server: ${uri}`);
      }
      const authMethod = (body.token_endpoint_auth_method as string | undefined) ?? "client_secret_basic";
      if (!["none", "client_secret_post", "client_secret_basic"].includes(authMethod)) {
        throw new OAuthError("invalid_client_metadata", `unsupported token_endpoint_auth_method ${authMethod}`);
      }
      if (this.store.clientCount() >= (this.opts.maxClients ?? 500)) {
        throw new OAuthError("invalid_client_metadata", "client registration limit reached");
      }
      const client: RegisteredClient = {
        client_id: randomUUID(),
        client_id_issued_at: nowSec(),
        client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 200) : undefined,
        redirect_uris: redirectUris as string[],
        token_endpoint_auth_method: authMethod,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...(authMethod === "none" ? {} : { client_secret: b64url(randomBytes(32)), client_secret_expires_at: 0 }),
      };
      this.store.saveClient(client);
      res.status(201).json(client);
    } catch (err) {
      sendOAuthError(res, err);
    }
  }

  // --- /token -----------------------------------------------------------------------------

  private async token(req: Request, res: Response) {
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
    try {
      const client = await this.authenticateClient(req);
      const body = req.body as Record<string, string | undefined>;
      if (body.grant_type === "authorization_code") {
        res.json(this.exchangeCode(client, body));
      } else if (body.grant_type === "refresh_token") {
        res.json(this.exchangeRefreshToken(client, body));
      } else {
        throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
      }
    } catch (err) {
      sendOAuthError(res, err);
    }
  }

  private exchangeCode(client: Client, body: Record<string, string | undefined>) {
    const code = body.code;
    const record = code ? this.codes.get(code) : undefined;
    if (code) this.codes.delete(code); // single use, even when the exchange fails
    if (!record || record.expiresAt < Date.now()) throw new OAuthError("invalid_grant", "authorization code is invalid or expired");
    if (record.clientId !== client.id) throw new OAuthError("invalid_grant", "authorization code was issued to another client");
    if (!body.code_verifier || !pkceMatches(body.code_verifier, record.codeChallenge)) {
      throw new OAuthError("invalid_grant", "code_verifier does not match the challenge");
    }
    if (body.redirect_uri !== undefined && body.redirect_uri !== record.redirectUri) {
      throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
    }
    if (body.resource && normResource(body.resource) !== normResource(record.resource)) {
      throw new OAuthError("invalid_target", "resource does not match the authorization request");
    }
    return this.issueTokens(client.id, record.scopes, record.resource, randomUUID());
  }

  private exchangeRefreshToken(client: Client, body: Record<string, string | undefined>) {
    if (!body.refresh_token) throw new OAuthError("invalid_request", "refresh_token is required");
    const hash = sha256hex(body.refresh_token);
    const record = this.store.getRefreshToken(hash);
    if (!record) {
      // A rotated token presented again means it leaked: revoke the whole chain.
      const family = this.store.rotatedFamily(hash);
      if (family) this.store.revokeFamily(family, nowSec() + this.opts.accessTokenTtlSec);
      throw new OAuthError("invalid_grant", "refresh token is invalid or was already used");
    }
    if (record.clientId !== client.id) throw new OAuthError("invalid_grant", "refresh token was issued to another client");
    if (record.expiresAt < nowSec()) {
      this.store.deleteRefreshToken(hash);
      throw new OAuthError("invalid_grant", "refresh token expired");
    }
    if (body.resource && normResource(body.resource) !== normResource(record.resource)) {
      throw new OAuthError("invalid_target", "resource does not match the original grant");
    }
    // Grants from before read-only connections carry the legacy scope: normalize before narrowing.
    const granted = normalizeScopes(record.scopes);
    const requested = normalizeScopes((body.scope ?? "").split(" ").filter(Boolean)).filter((s) => granted.includes(s));
    const scopes = requested.length ? requested : granted;
    this.store.rotateRefreshToken(hash);
    return this.issueTokens(client.id, scopes, record.resource, record.family);
  }

  private async revoke(req: Request, res: Response) {
    res.set("Cache-Control", "no-store");
    try {
      const client = await this.authenticateClient(req);
      const token = (req.body as Record<string, string | undefined>).token;
      if (!token) throw new OAuthError("invalid_request", "token is required");
      const record = this.store.getRefreshToken(sha256hex(token));
      if (record && record.clientId === client.id) this.store.revokeFamily(record.family, nowSec() + this.opts.accessTokenTtlSec);
      res.status(200).end(); // RFC 7009: unknown tokens are not an error
    } catch (err) {
      sendOAuthError(res, err);
    }
  }

  private issueTokens(clientId: string, scopes: string[], resource: string, family: string) {
    const exp = nowSec() + this.opts.accessTokenTtlSec;
    const payload = b64url(JSON.stringify({ cid: clientId, scp: scopes, aud: resource, exp, fam: family, jti: randomUUID() }));
    const refreshToken = b64url(randomBytes(32));
    this.store.saveRefreshToken(sha256hex(refreshToken), {
      clientId,
      scopes,
      resource,
      family,
      expiresAt: nowSec() + this.opts.refreshTokenTtlSec,
    });
    return {
      access_token: `${payload}.${this.sign(payload)}`,
      token_type: "Bearer",
      expires_in: this.opts.accessTokenTtlSec,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private sign(data: string) {
    return createHmac("sha256", this.store.signingKey).update(data).digest("base64url");
  }

  private async checkPassword(input: string) {
    const [expected, given] = await Promise.all([this.passwordHash, scryptAsync(input, this.passwordSalt, 32)]);
    return timingSafeEqual(given, expected);
  }

  private sweep() {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expiresAt < now) this.pending.delete(id);
    for (const [code, c] of this.codes) if (c.expiresAt < now) this.codes.delete(code);
  }
}

/** Constant-time comparison of two secrets of any length (HMAC first, so lengths always match). */
function safeEqual(a: string, b: string) {
  const x = createHmac("sha256", COMPARE_KEY).update(a).digest();
  const y = createHmac("sha256", COMPARE_KEY).update(b).digest();
  return timingSafeEqual(x, y);
}

function sendOAuthError(res: Response, err: unknown) {
  if (err instanceof OAuthError) {
    if (err.status === 401) res.set("WWW-Authenticate", 'Basic realm="oauth"');
    res.status(err.status).json({ error: err.code, error_description: err.message });
    return;
  }
  console.error("OAuth endpoint failed:", err);
  res.status(500).json({ error: "server_error", error_description: "Internal error" });
}

function sendHtml(res: Response, html: string) {
  res
    .set({
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    })
    .type("html")
    .send(html);
}
