import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(40), DOSSIER_PASSWORD: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA" } }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/profile-data", () => ({
  loadProfile: async () => ({ basics: { city: "Bangalore", country: "India" }, skills: [], languages: [], experience: [], projects: [], education: [], references: [] }),
}));
const searches = vi.hoisted(() => ({ ran: [] as unknown[] }));
vi.mock("@/lib/posting-searches", () => ({
  runSearch: async (query: unknown) => (searches.ran.push(query), { ok: true, id: "s1" }),
  loadSearch: async () => ({ id: "s1", postings: [], next: null }),
  showMoreFor: async () => ({ ok: true, postings: [], next: null }),
}));

import { challengeOf, exchangeCode, issueCode, registerClient } from "@/lib/connector/oauth";

import { POST } from "./route";

const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

async function accessToken(): Promise<string> {
  const clientId = await registerClient({ name: "Claude", redirectUris: [CLAUDE] });
  const verifier = "v".repeat(50);
  const code = await issueCode({ clientId, redirectUri: CLAUDE, codeChallenge: challengeOf(verifier), resource: "" });
  return (await exchangeCode({ code, clientId, redirectUri: CLAUDE, verifier })).access_token;
}

const call = (body: unknown, token?: string) =>
  POST(
    new Request("https://dossier.example/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

describe("the Claude connector at /api/mcp", () => {
  it("asks Claude to sign in, and says where to find out how", async () => {
    const response = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://dossier.example/.well-known/oauth-protected-resource/api/mcp", scope="dossier"',
    );
    expect((await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "not-a-token")).status).toBe(401);
  });

  it("answers MCP with Dossier's tools once signed in", async () => {
    const token = await accessToken();
    const init = await call(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      token,
    );
    expect(init.status).toBe(200);
    expect(await init.json()).toMatchObject({ result: { serverInfo: { name: "dossier" } } });

    const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" }, token);
    const { result } = (await list.json()) as { result: { tools: { name: string }[] } };
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "check_draft",
      "draft_application",
      "get_application",
      "get_posting",
      "get_profile",
      "list_applications",
      "more_jobs",
      "save_application",
      "search_jobs",
      "set_application_status",
    ]);
  });

  it("searches Bangalore plus remote jobs in India by default", async () => {
    const token = await accessToken();
    const response = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_jobs", arguments: { keywords: "android developer" } } }, token);
    const { result } = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(result.isError).toBeFalsy();
    expect(searches.ran.at(-1)).toMatchObject({ keywords: "android developer", place: "Bangalore", country: "in", alsoRemote: true, remoteOnly: false, postedWithin: "month" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ search_id: "s1", searched: "android developer in Bangalore plus remote" });
  });

  it("asks Claude to write the application itself when Dossier has no AI model", async () => {
    const token = await accessToken();
    const response = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "draft_application", arguments: { posting_text: "Android developer at Acme" } } }, token);
    const { result } = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("save_application");
  });
});
