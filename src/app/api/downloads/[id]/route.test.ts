import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSession } from "@/lib/auth/session";
import { getJob } from "@/lib/jobs/runner";

import { GET } from "./route";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/jobs/runner", () => ({ getJob: vi.fn(), defineJob: <T,>(definition: T) => definition }));
// The stored zips, by name.
const stored = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock("@/lib/stored-files", () => ({
  readStoredFile: async (_kind: string, name: string) => (stored.has(name) ? { name, data: stored.get(name) } : null),
  removeStoredFile: async (_kind: string, name: string) => void stored.delete(name),
  removeStoredFiles: async () => 0,
  storeFile: async () => ({}),
}));

const get = (id: string) => GET(new NextRequest(`http://localhost:3000/api/downloads/${id}`), { params: Promise.resolve({ id }) });
const done = { id: "job-1", type: "zip-pdfs", status: "DONE", step: null, error: null, result: { file: "abc-123.zip", fileName: "dossier-pdfs-2026-09-28.zip", documents: 2 } } as const;

beforeEach(async () => {
  stored.clear();
  stored.set("abc-123.zip", new TextEncoder().encode("PK zip"));
  vi.mocked(getSession).mockResolvedValue({ persistent: false, issuedAt: new Date(), expiresAt: new Date() });
  vi.mocked(getJob).mockResolvedValue(done);
});

describe("GET /api/downloads/[id] (E10-5)", () => {
  it("hands over the zip once, then removes it", async () => {
    const response = await get("job-1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain('filename="dossier-pdfs-2026-09-28.zip"');
    expect(await response.text()).toBe("PK zip");
    expect(stored.size).toBe(0);
    expect((await get("job-1")).status).toBe(410);
  });

  it("serves nothing but finished zip jobs", async () => {
    vi.mocked(getJob).mockResolvedValue({ ...done, type: "refine" });
    expect((await get("job-1")).status).toBe(404);
    vi.mocked(getJob).mockResolvedValue({ ...done, status: "RUNNING" });
    expect((await get("job-1")).status).toBe(404);
    vi.mocked(getJob).mockResolvedValue({ ...done, result: { ...done.result, file: "../../etc/passwd" } });
    expect((await get("job-1")).status).toBe(404);
  });
});
