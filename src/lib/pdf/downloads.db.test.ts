import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient, resetDatabase } from "@/test/db";

import { HOLD_MS, heldPdf, holdPdf, pdfDownload } from "./downloads";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});

const pdf = new Uint8Array([37, 80, 68, 70]);

beforeEach(async () => {
  await resetDatabase(db.client!);
});
afterAll(async () => {
  await db.client!.$disconnect();
});

describe("held PDFs", () => {
  it("keeps a rendered PDF for its download, more than once, until it expires", async () => {
    const now = Date.now();
    const id = await holdPdf(pdf, "Jane – Resume.pdf", now);
    expect(await heldPdf(id, now + 1_000)).toEqual({ pdf, fileName: "Jane – Resume.pdf" });
    expect(await heldPdf(id, now + 2_000)).not.toBeNull();
    expect(await heldPdf(id, now + HOLD_MS)).toBeNull();
  });

  it("finds nothing for an id that isn't one", async () => {
    expect(await heldPdf("../../etc/passwd")).toBeNull();
  });

  it("answers with the PDF as a named download", async () => {
    const response = pdfDownload(pdf, "Jane – Resume.pdf");
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''Jane%20%E2%80%93%20Resume.pdf");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pdf);
  });
});
