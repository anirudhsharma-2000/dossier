import { describe, expect, it, vi } from "vitest";

const secrets = vi.hoisted(() => ({ password: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA" }));
vi.mock("@/lib/env", () => ({
  env: {
    DOSSIER_SECRET: "s".repeat(40),
    get DOSSIER_PASSWORD() {
      return secrets.password;
    },
  },
}));

import {
  allowedRedirect,
  authorizationServerMetadata,
  challengeOf,
  clientAllows,
  exchangeCode,
  issueCode,
  protectedResourceMetadata,
  readClient,
  refresh,
  registerClient,
  verifyAccessToken,
} from "./oauth";

const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const verifier = "a".repeat(43);

async function signIn(redirectUri = CLAUDE) {
  const clientId = await registerClient({ name: "Claude", redirectUris: [redirectUri] });
  const code = await issueCode({ clientId, redirectUri, codeChallenge: challengeOf(verifier), resource: "https://dossier.example/api/mcp" });
  return { clientId, code };
}

describe("the connector's sign-in", () => {
  it("only lets Claude's own callbacks register", () => {
    expect(allowedRedirect(CLAUDE)).toBe(true);
    expect(allowedRedirect("https://claude.com/api/mcp/auth_callback")).toBe(true);
    expect(allowedRedirect("http://localhost:53122/callback")).toBe(true);
    expect(allowedRedirect("http://127.0.0.1:8080/callback")).toBe(true);
    expect(allowedRedirect("https://evil.example/api/mcp/auth_callback")).toBe(false);
    expect(allowedRedirect("http://localhost:8080/elsewhere")).toBe(false);
    expect(allowedRedirect("https://claude.ai.evil.example/api/mcp/auth_callback")).toBe(false);
  });

  it("remembers a client's redirects in its id, and matches loopback ports loosely", async () => {
    const clientId = await registerClient({ name: "Claude Code", redirectUris: ["http://localhost/callback"] });
    const client = await readClient(clientId);
    expect(client).toEqual({ name: "Claude Code", redirectUris: ["http://localhost/callback"] });
    expect(clientAllows(client!, "http://localhost:61000/callback")).toBe(true);
    expect(clientAllows(client!, CLAUDE)).toBe(false);
    expect(await readClient("made-up")).toBeNull();
  });

  it("trades a code for tokens once the PKCE verifier matches", async () => {
    const { clientId, code } = await signIn();
    const tokens = await exchangeCode({ code, clientId, redirectUri: CLAUDE, verifier });
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "dossier" });
    expect(await verifyAccessToken(tokens.access_token)).toBe(true);
    expect(await verifyAccessToken(tokens.refresh_token)).toBe(false);
    expect(await verifyAccessToken(code)).toBe(false);
  });

  it("refuses a wrong verifier, another client or another redirect", async () => {
    const { clientId, code } = await signIn();
    await expect(exchangeCode({ code, clientId, redirectUri: CLAUDE, verifier: "b".repeat(43) })).rejects.toMatchObject({ code: "invalid_grant" });
    const other = await registerClient({ name: "Other", redirectUris: [CLAUDE] });
    await expect(exchangeCode({ code, clientId: other, redirectUri: CLAUDE, verifier })).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(exchangeCode({ code, clientId, redirectUri: "http://localhost:1/callback", verifier })).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("refreshes tokens, and signs Claude out when the password changes", async () => {
    const { clientId, code } = await signIn();
    const tokens = await exchangeCode({ code, clientId, redirectUri: CLAUDE, verifier });
    const renewed = await refresh({ refreshToken: tokens.refresh_token, clientId });
    expect(await verifyAccessToken(renewed.access_token)).toBe(true);

    const before = secrets.password;
    secrets.password = "argon2id:m=19456,t=2,p=1:bmV3:bmV3aGFzaA";
    try {
      expect(await verifyAccessToken(renewed.access_token)).toBe(false);
      await expect(refresh({ refreshToken: renewed.refresh_token, clientId })).rejects.toMatchObject({ code: "invalid_grant" });
    } finally {
      secrets.password = before;
    }
  });

  it("describes itself where OAuth clients look", () => {
    expect(authorizationServerMetadata("https://dossier.example")).toMatchObject({
      issuer: "https://dossier.example",
      authorization_endpoint: "https://dossier.example/oauth/authorize",
      token_endpoint: "https://dossier.example/api/oauth/token",
      registration_endpoint: "https://dossier.example/api/oauth/register",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    expect(protectedResourceMetadata("https://dossier.example")).toMatchObject({
      resource: "https://dossier.example/api/mcp",
      authorization_servers: ["https://dossier.example"],
    });
  });
});
