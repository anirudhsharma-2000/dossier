import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings, saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { lastNightlyBackup, nextRun, pruneBackups, runNightlyBackup } from "./backup-schedule";
import { backupFileName, listBackups, writeBackup } from "./backups";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({
  env: { DOSSIER_BACKUP_RETENTION_DAYS: 14, DOSSIER_SECRET: "s".repeat(32) },
}));
vi.mock("@/lib/log", () => ({ logServerError: vi.fn() }));

const prisma = () => db.client!;
const backups = async () => (await listBackups()).map((backup) => backup.name);

beforeEach(async () => {
  await resetDatabase(prisma());
  await prisma().application.create({ data: { company: "Ledgerly" } });
});
afterAll(async () => {
  await prisma().$disconnect();
});

describe("nightly backups (E10-7)", () => {
  it("run at the next 03:00", () => {
    expect(nextRun(new Date(2026, 8, 28, 1, 30))).toEqual(new Date(2026, 8, 28, 3, 0));
    expect(nextRun(new Date(2026, 8, 28, 3, 0))).toEqual(new Date(2026, 8, 29, 3, 0));
    expect(nextRun(new Date(2026, 8, 28, 22, 0))).toEqual(new Date(2026, 8, 29, 3, 0));
  });

  it("write an export while they're on, kept in the database", async () => {
    const now = new Date(2026, 8, 28, 3, 0);
    expect(await runNightlyBackup(now)).toBe("written");
    expect(await backups()).toEqual(["dossier-backup-nightly-2026-09-28-030000.json"]);
    expect(await lastNightlyBackup()).toEqual(now);
    const stored = await prisma().storedFile.findFirstOrThrow({ where: { kind: "backup" } });
    expect(JSON.parse(Buffer.from(stored.data).toString("utf8"))).toMatchObject({ format: expect.any(String) });
  });

  it("write nothing while they're off", async () => {
    await saveSettings({ nightlyBackup: false });
    expect(await runNightlyBackup()).toBe("off");
    expect(await backups()).toEqual([]);
  });

  it("remove backups past the retention", async () => {
    const now = new Date();
    await writeBackup("nightly", new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
    await writeBackup("nightly", now);
    expect(await backups()).toHaveLength(2);
    expect(await pruneBackups(now)).toBe(1);
    expect(await backups()).toEqual([backupFileName("nightly", now)]);
  });

  it("keep a failure for the settings row, and clear it after a success", async () => {
    const store = vi.spyOn(prisma().storedFile, "upsert").mockRejectedValueOnce(new Error("The database is full."));
    await expect(runNightlyBackup()).rejects.toThrow();
    expect((await loadSettings()).backupProblem).toBe("The database is full.");
    store.mockRestore();

    await runNightlyBackup();
    expect((await loadSettings()).backupProblem).toBeNull();
  });
});
