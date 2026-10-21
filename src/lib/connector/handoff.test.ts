import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/postings", () => ({ storePosting: vi.fn(async () => ({ id: "post_123" })) }));
vi.mock("@/lib/job-search/find", () => ({ fullText: vi.fn(async () => "The whole text") }));
const stored = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock("@/lib/stored-files", () => ({
  storeFile: async (_kind: string, name: string, data: Uint8Array) => void stored.set(name, data),
  readStoredFile: async (_kind: string, name: string) => (stored.has(name) ? { data: stored.get(name) } : null),
}));

import { handOffFoundPosting, handOffPastedPosting, readPastedPosting } from "./handoff";

const promptOf = (url: string) => decodeURIComponent(new URL(url).searchParams.get("q")!);

describe("handing work to Claude chat", () => {
  it("names a Find jobs posting by its id, for the connector's tools", async () => {
    const posting = { source: "JSEARCH", externalId: "j1", title: "Android Developer", company: "Acme", place: "Bangalore", remote: null, salary: "", postedAt: null, url: "", via: "", description: "Kotlin", complete: false } as const;
    const write = await handOffFoundPosting(posting, "write");
    expect(write).toMatch(/^https:\/\/claude\.ai\/new\?q=/);
    expect(promptOf(write)).toContain('posting_id "post_123" (Android Developer at Acme)');
    expect(promptOf(write)).toContain("save_application");
    expect(promptOf(await handOffFoundPosting(posting, "score"))).toContain("save_job_scores");
    expect(write.length).toBeLessThan(2000);
  });

  it("keeps a pasted posting for Claude to read, however long", async () => {
    const text = "Senior Android Developer. ".repeat(500);
    const url = await handOffPastedPosting({ text, url: "https://jobs.example/1" });
    const id = /paste_id "([^"]+)"/.exec(promptOf(url))![1];
    expect(url.length).toBeLessThan(2000);
    expect(await readPastedPosting(id)).toEqual({ text, url: "https://jobs.example/1" });
    expect(await readPastedPosting("../nope")).toBeNull();
  });
});
