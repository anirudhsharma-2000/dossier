import "server-only";

import { buildExport } from "@/lib/data-export";
import { prisma } from "@/lib/prisma";
import { listStoredFiles, removeStoredFile, removeStoredFiles, storeFile } from "@/lib/stored-files";

// Backups (E10-6, E10-7): exports kept in the database's StoredFile table
// (they used to go to DOSSIER_DATA_DIR/backups). They never hold the API key
// in plain text.

export type BackupReason = "before-import" | "nightly";

/** Where backups are kept, in words for Settings. */
export const BACKUPS_WHERE = "the database";

const pad = (value: number) => String(value).padStart(2, "0");

/** "dossier-backup-nightly-2026-09-28-030000.json", in the server's time zone. */
export function backupFileName(reason: BackupReason, now: Date): string {
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `dossier-backup-${reason}-${day}-${time}.json`;
}

/** Keeps an export of everything as a backup; returns the file's name. */
export async function writeBackup(reason: BackupReason, now = new Date()): Promise<string> {
  const data = await buildExport(prisma, { now });
  const name = backupFileName(reason, now);
  await storeFile("backup", name, Buffer.from(JSON.stringify(data, null, 2)), { contentType: "application/json", createdAt: now });
  return name;
}

/** The backups, newest first. */
export async function listBackups(): Promise<{ name: string; modified: Date }[]> {
  const files = await listStoredFiles("backup");
  return files.filter((file) => /^dossier-backup-.*\.json$/.test(file.name)).map((file) => ({ name: file.name, modified: file.createdAt }));
}

/** Deletes one backup. */
export async function deleteBackup(name: string): Promise<void> {
  await removeStoredFile("backup", name);
}

/** Deletes every backup (Delete everything, E10-8). */
export async function deleteAllBackups(): Promise<void> {
  await removeStoredFiles("backup");
}
