import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { jwtVerify, SignJWT } from "jose";

import { passwordFingerprint } from "@/lib/auth/session";
import { deriveKey } from "@/lib/keys";

// Sign-in for the Claude connector (src/app/api/mcp): a small OAuth 2.1
// authorization server, as Claude's custom connectors expect it, with
// Dynamic Client Registration and PKCE (S256). It keeps nothing in the
// database: clients, codes and tokens are signed with keys derived from
// DOSSIER_SECRET, and every token carries a fingerprint of DOSSIER_PASSWORD,
// so changing the password or the secret signs Claude out too, as it does
// every browser.

/** Where Claude's hosted apps (claude.ai, Desktop, mobile) come back to after sign-in. */
const HOSTED_CALLBACKS = new Set(["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"]);

/** What a token lets Claude do; there's only one thing. */
export const SCOPE = "dossier";

export const ACCESS_TOKEN_SECONDS = 60 * 60;
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const CODE_SECONDS = 5 * 60;

const AUDIENCE = { client: "dossier-oauth-client", code: "dossier-oauth-code", access: "dossier-mcp", refresh: "dossier-oauth-refresh" } as const;
const key = (kind: keyof typeof AUDIENCE) => deriveKey(`oauth-${kind}`);

/**
 * Whether Claude may be sent back to `uri`: Claude's own callback, or a
 * loopback address on any port (Claude Code signs in through one).
 */
export function allowedRedirect(uri: string): boolean {
  if (HOSTED_CALLBACKS.has(uri)) return true;
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.pathname === "/callback";
  } catch {
    return false;
  }
}

/** The same redirect, ignoring a loopback address's port, which changes each time. */
function sameRedirect(registered: string, given: string): boolean {
  if (registered === given) return true;
  try {
    const a = new URL(registered);
    const b = new URL(given);
    const loopback = (url: URL) => url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return loopback(a) && loopback(b) && a.hostname === b.hostname && a.pathname === b.pathname && a.protocol === b.protocol;
  } catch {
    return false;
  }
}

async function sign(kind: keyof typeof AUDIENCE, claims: Record<string, unknown>, seconds: number): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(AUDIENCE[kind])
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(`${seconds}s`)
    .sign(key(kind));
}

async function verify(kind: keyof typeof AUDIENCE, token: string | null | undefined): Promise<Record<string, unknown> | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(kind), { audience: AUDIENCE[kind], algorithms: ["HS256"] });
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Clients ─────────────────────────────────────────────────────────────────

export type Client = { name: string; redirectUris: string[] };

/** Registers a client (RFC 7591): its id is a signed note of its redirects. */
export async function registerClient(client: Client): Promise<string> {
  // Clients don't expire: Claude keeps the one it registered.
  return new SignJWT({ name: client.name, redirect_uris: client.redirectUris })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(AUDIENCE.client)
    .setIssuedAt()
    .sign(key("client"));
}

export async function readClient(clientId: string | null | undefined): Promise<Client | null> {
  const claims = await verify("client", clientId);
  const uris = claims?.redirect_uris;
  if (!claims || !Array.isArray(uris) || !uris.every((uri) => typeof uri === "string")) return null;
  return { name: typeof claims.name === "string" ? claims.name : "Claude", redirectUris: uris };
}

/** Whether a client registered `redirectUri`. */
export const clientAllows = (client: Client, redirectUri: string) => client.redirectUris.some((uri) => sameRedirect(uri, redirectUri));

// ─── Codes and tokens ────────────────────────────────────────────────────────

/** The one-time code handed back after the user allows Claude in, valid for five minutes. */
export function issueCode(grant: { clientId: string; redirectUri: string; codeChallenge: string; resource: string }): Promise<string> {
  return sign("code", { cid: grant.clientId, uri: grant.redirectUri, chl: grant.codeChallenge, res: grant.resource, pwd: passwordFingerprint() }, CODE_SECONDS);
}

/** S256: the challenge is the verifier's SHA-256, base64url-encoded. */
export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export type TokenPair = { access_token: string; refresh_token: string; token_type: "Bearer"; expires_in: number; scope: string };

async function tokens(clientId: string, resource: string): Promise<TokenPair> {
  const pwd = passwordFingerprint();
  return {
    access_token: await sign("access", { cid: clientId, res: resource, scope: SCOPE, pwd }, ACCESS_TOKEN_SECONDS),
    refresh_token: await sign("refresh", { cid: clientId, res: resource, pwd }, REFRESH_TOKEN_SECONDS),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_SECONDS,
    scope: SCOPE,
  };
}

export class OAuthError extends Error {
  constructor(
    readonly code: "invalid_request" | "invalid_grant" | "invalid_client" | "unsupported_grant_type",
    message: string,
  ) {
    super(message);
  }
}

/** Trades a code for tokens, checking the client, the redirect and the PKCE verifier. */
export async function exchangeCode({ code, clientId, redirectUri, verifier }: { code: string; clientId: string; redirectUri: string; verifier: string }): Promise<TokenPair> {
  const claims = await verify("code", code);
  if (!claims || claims.pwd !== passwordFingerprint()) throw new OAuthError("invalid_grant", "The code is invalid or has expired.");
  if (claims.cid !== clientId) throw new OAuthError("invalid_grant", "The code was issued to another client.");
  if (typeof claims.uri !== "string" || !sameRedirect(claims.uri, redirectUri)) throw new OAuthError("invalid_grant", "The redirect URI doesn't match.");
  if (!verifier || challengeOf(verifier) !== claims.chl) throw new OAuthError("invalid_grant", "The code verifier doesn't match.");
  return tokens(clientId, String(claims.res ?? ""));
}

/** New tokens for a refresh token, with a new refresh token too. */
export async function refresh({ refreshToken, clientId }: { refreshToken: string; clientId: string }): Promise<TokenPair> {
  const claims = await verify("refresh", refreshToken);
  if (!claims || claims.pwd !== passwordFingerprint() || claims.cid !== clientId) {
    throw new OAuthError("invalid_grant", "The refresh token is invalid or has expired.");
  }
  return tokens(clientId, String(claims.res ?? ""));
}

/** Whether a bearer token lets Claude use Dossier now. */
export async function verifyAccessToken(token: string | null | undefined): Promise<boolean> {
  const claims = await verify("access", token);
  return Boolean(claims && claims.scope === SCOPE && claims.pwd === passwordFingerprint());
}

// ─── Addresses ───────────────────────────────────────────────────────────────

/** This server's address as the request reached it, e.g. https://dossier.example.com. */
export function originOf(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() || url.protocol.replace(/:$/, "");
  const host = request.headers.get("x-forwarded-host")?.split(",")[0].trim() || request.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

/** The MCP endpoint, as Claude is given it. */
export const mcpUrl = (origin: string) => `${origin}/api/mcp`;

/** RFC 8414 metadata: where Claude registers, signs in and gets tokens. */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  };
}

/** RFC 9728 metadata: which server protects the MCP endpoint. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Dossier",
  };
}
