import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { sweepFinishedJobs } from "./retention";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(32) } }));

const prisma = () => db.client!;
const now = new Date("2026-10-18T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);
const left = async () => (await prisma().job.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((job) => job.id);

beforeEach(async () => {
  await resetDatabase(prisma());
  await prisma().job.createMany({
    data: [
      { id: "import-old", type: "import-profile", status: "DONE", finishedAt: hoursAgo(25), input: { resume: "Jane Doe, jane@example.com" } },
      { id: "read-old", type: "read-posting", status: "FAILED", finishedAt: hoursAgo(30), input: { posting: "…" } },
      { id: "write-recent", type: "write-documents", status: "DONE", finishedAt: hoursAgo(2), input: { posting: "…" } },
      { id: "queued", type: "refine", status: "QUEUED", input: {} },
      { id: "running", type: "refine", status: "RUNNING", startedAt: hoursAgo(48), input: {} },
    ],
  });
});
afterAll(() => prisma().$disconnect());

describe("sweepFinishedJobs", () => {
  it("deletes finished jobs older than the setting, 24 hours by default, and leaves unfinished ones", async () => {
    expect(await sweepFinishedJobs(now)).toBe(2);
    expect(await left()).toEqual(["queued", "running", "write-recent"]);
  });

  it("keeps them as long as the setting says", async () => {
    await saveSettings({ jobRetentionHours: 1 });
    expect(await sweepFinishedJobs(now)).toBe(3);
    expect(await left()).toEqual(["queued", "running"]);

    await prisma().job.create({ data: { id: "week", type: "read-posting", status: "DONE", finishedAt: hoursAgo(100), input: {} } });
    await saveSettings({ jobRetentionHours: 24 * 7 });
    expect(await sweepFinishedJobs(now)).toBe(0);
  });

  it("goes by the last change for a finished job without an end time", async () => {
    await prisma().job.create({ data: { id: "no-end", type: "read-posting", status: "DONE", input: {} } });
    await prisma().$executeRaw`UPDATE "Job" SET "updatedAt" = ${hoursAgo(25)} WHERE id = 'no-end'`;
    await sweepFinishedJobs(now);
    expect(await left()).not.toContain("no-end");
  });

  it("removes zips nobody downloaded", async () => {
    const zip = (name: string, createdAt: Date) => ({ kind: "download", name, contentType: "application/zip", data: Buffer.from("zip"), createdAt });
    await prisma().storedFile.createMany({ data: [zip("old.zip", hoursAgo(2)), zip("new.zip", now)] });
    await sweepFinishedJobs(now);
    expect((await prisma().storedFile.findMany({ select: { name: true } })).map((file) => file.name)).toEqual(["new.zip"]);
  });
});
