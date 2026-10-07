import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Response } from "express";
import { rateLimit } from "express-rate-limit";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { AuthStore } from "./store.js";
import { renderLoginPage } from "./login-page.js";

export interface OwnerAuthOptions {
  dataDir: string;
  ownerPassword: string;
  /** Canonical resource (MCP endpoint URL); tokens are bound to it. */
  resource: URL;
  scopes: string[];
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  allowedRedirectUris: string[];
  maxClients?: number;
}

interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
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

const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Single-owner OAuth 2.1 authorization server: any MCP client may register (DCR) but every
 * authorization must be approved on a consent page with the owner's password.
 */
export class OwnerOAuthProvider implements OAuthServerProvider {
  private readonly store: AuthStore;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly passwordHash: Buffer;

  constructor(private readonly opts: OwnerAuthOptions) {
    this.store = new AuthStore(opts.dataDir);
    this.passwordHash = createHash("sha256").update(opts.ownerPassword).digest();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.store.getClient(id),
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        for (const uri of full.redirect_uris) {
          if (!this.opts.allowedRedirectUris.some((allowed) => redirectUriMatches(uri, allowed))) {
            throw new InvalidClientMetadataError(`redirect_uri not allowed by this server: ${uri}`);
          }
        }
        if (this.store.clientCount() >= (this.opts.maxClients ?? 500)) {
          throw new InvalidClientMetadataError("client registration limit reached");
        }
        this.store.saveClient(full);
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.sweep();
    const requestId = randomUUID();
    this.pending.set(requestId, { client, params, expiresAt: Date.now() + PENDING_TTL_MS });
    sendLoginPage(res, {
      requestId,
      clientName: client.client_name ?? client.client_id,
      redirectHost: new URL(params.redirectUri).host,
    });
  }

  /** Express router for the consent form posted by the login page. */
  consentRouter() {
    const router = express.Router();
    router.post(
      "/",
      rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }),
      express.urlencoded({ extended: false }),
      (req, res) => {
        const { request_id, password, action } = req.body as Record<string, string | undefined>;
        const pending = request_id ? this.pending.get(request_id) : undefined;
        if (!pending || pending.expiresAt < Date.now()) {
          res.status(400).type("text/plain").send("This sign-in request has expired. Start again from Claude.");
          return;
        }
        const { client, params } = pending;
        const redirect = new URL(params.redirectUri);
        if (params.state !== undefined) redirect.searchParams.set("state", params.state);

        if (action !== "approve") {
          this.pending.delete(request_id!);
          redirect.searchParams.set("error", "access_denied");
          res.redirect(302, redirect.href);
          return;
        }
        if (!this.checkPassword(password ?? "")) {
          sendLoginPage(res.status(401), {
            requestId: request_id!,
            clientName: client.client_name ?? client.client_id,
            redirectHost: redirect.host,
            error: "Wrong password",
          });
          return;
        }

        this.pending.delete(request_id!);
        const code = b64url(randomBytes(32));
        this.codes.set(code, {
          clientId: client.client_id,
          codeChallenge: params.codeChallenge,
          redirectUri: params.redirectUri,
          scopes: params.scopes?.length ? params.scopes : this.opts.scopes,
          resource: (params.resource ?? this.opts.resource).href,
          expiresAt: Date.now() + CODE_TTL_MS,
        });
        redirect.searchParams.set("code", code);
        res.redirect(302, redirect.href);
      },
    );
    return router;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    return this.getCode(client, code).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.getCode(client, code);
    this.codes.delete(code); // single use
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && !sameResource(resource.href, record.resource)) {
      throw new InvalidGrantError("resource does not match the authorization request");
    }
    return this.issueTokens(client.client_id, record.scopes, record.resource, randomUUID());
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const hash = sha256(refreshToken);
    const record = this.store.getRefreshToken(hash);
    if (!record) {
      // A rotated token presented again means it leaked: revoke the whole chain.
      const family = this.store.rotatedFamily(hash);
      if (family) this.store.revokeFamily(family);
      throw new InvalidGrantError("refresh token is invalid or was already used");
    }
    if (record.clientId !== client.client_id) throw new InvalidGrantError("refresh token was issued to another client");
    if (record.expiresAt < nowSec()) {
      this.store.deleteRefreshToken(hash);
      throw new InvalidGrantError("refresh token expired");
    }
    if (resource && !sameResource(resource.href, record.resource)) {
      throw new InvalidGrantError("resource does not match the original grant");
    }
    const granted = scopes?.length ? scopes.filter((s) => record.scopes.includes(s)) : record.scopes;
    this.store.rotateRefreshToken(hash);
    return this.issueTokens(client.client_id, granted, record.resource, record.family);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const [payloadPart, sig] = token.split(".");
    if (!payloadPart || !sig) throw new InvalidTokenError("Malformed access token");
    const expected = this.sign(payloadPart);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new InvalidTokenError("Invalid access token");

    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
      cid: string;
      scp: string[];
      aud: string;
      exp: number;
    };
    if (!this.store.getClient(payload.cid)) throw new InvalidTokenError("Client no longer registered");
    return {
      token,
      clientId: payload.cid,
      scopes: payload.scp,
      expiresAt: payload.exp,
      resource: new URL(payload.aud),
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    // Access tokens are short-lived and stateless; revoking a refresh token ends the grant.
    const hash = sha256(request.token);
    const record = this.store.getRefreshToken(hash);
    if (record && record.clientId === client.client_id) this.store.revokeFamily(record.family);
  }

  private issueTokens(clientId: string, scopes: string[], resource: string, family: string): OAuthTokens {
    const exp = nowSec() + this.opts.accessTokenTtlSec;
    const payload = b64url(JSON.stringify({ cid: clientId, scp: scopes, aud: resource, exp, jti: randomUUID() }));
    const accessToken = `${payload}.${this.sign(payload)}`;

    const refreshToken = b64url(randomBytes(32));
    this.store.saveRefreshToken(sha256(refreshToken), {
      clientId,
      scopes,
      resource,
      family,
      expiresAt: nowSec() + this.opts.refreshTokenTtlSec,
    });

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.opts.accessTokenTtlSec,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private getCode(client: OAuthClientInformationFull, code: string) {
    const record = this.codes.get(code);
    if (!record || record.expiresAt < Date.now()) {
      this.codes.delete(code);
      throw new InvalidGrantError("authorization code is invalid or expired");
    }
    if (record.clientId !== client.client_id) throw new InvalidGrantError("authorization code was issued to another client");
    return record;
  }

  private sign(data: string) {
    return createHmac("sha256", this.store.signingKey).update(data).digest("base64url");
  }

  private checkPassword(input: string) {
    return timingSafeEqual(createHash("sha256").update(input).digest(), this.passwordHash);
  }

  private sweep() {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expiresAt < now) this.pending.delete(id);
    for (const [code, c] of this.codes) if (c.expiresAt < now) this.codes.delete(code);
  }
}

function sameResource(a: string, b: string) {
  const norm = (s: string) => s.split("#")[0]!.replace(/\/$/, "");
  return norm(a) === norm(b);
}

function sendLoginPage(res: Response, view: Parameters<typeof renderLoginPage>[0]) {
  res
    .set({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    })
    .type("html")
    .send(renderLoginPage(view));
}
