import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(40), DOSSIER_PASSWORD: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA" } }));
const db = vi.hoisted(() => ({ postingSearch: { findUnique: vi.fn() }, postingScore: { upsert: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/ai/config", () => ({ isAiUsable: async () => false }));
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
      "add_startup",
      "check_draft",
      "draft_application",
      "find_startups",
      "get_application",
      "get_posting",
      "get_profile",
      "get_startup",
      "list_applications",
      "more_jobs",
      "refresh_startups",
      "save_application",
      "save_job_scores",
      "search_jobs",
      "set_application_status",
      "update_startup",
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

  it("saves the fit scores Claude gives postings, so Find jobs shows them", async () => {
    const token = await accessToken();
    const posting = { source: "JSEARCH", externalId: "j1", title: "Android Developer", company: "Acme", place: "Bangalore", remote: null, salary: "", postedAt: null, url: "", via: "", description: "Kotlin", complete: true };
    db.postingSearch.findUnique.mockResolvedValue({ postings: [posting] });
    const response = await call(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "save_job_scores", arguments: { search_id: "s1", scores: [{ number: 1, score: 78, reasons: ["Kotlin in the Acme role"] }, { number: 9, score: 10, reasons: ["?"] }] } } },
      token,
    );
    const { result } = (await response.json()) as { result: { content: { text: string }[] } };
    expect(JSON.parse(result.content[0].text)).toMatchObject({ saved: [{ number: 1, score: 78, band: "Good fit" }], not_found: [9] });
    expect(db.postingScore.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ externalId: "j1", score: 78, reasons: ["Kotlin in the Acme role"], redFlags: [], scoredWith: "claude-chat" }) }),
    );
  });
});
