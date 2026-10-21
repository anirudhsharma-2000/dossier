import "server-only";

import { prisma } from "@/lib/prisma";

// Files the server keeps for a while (backups, zips, PDFs waiting for their
// download), in the StoredFile table. They used to live in DOSSIER_DATA_DIR;
// in the database they survive on hosts without a lasting disk (Vercel) and
// are the same for every instance of the app.

export type StoredFileKind = "backup" | "download" | "pdf" | "paste";

/** Saves a file, replacing one of the same kind and name. */
export async function storeFile(
  kind: StoredFileKind,
  name: string,
  data: Uint8Array,
  { contentType, expiresAt = null, createdAt = new Date() }: { contentType: string; expiresAt?: Date | null; createdAt?: Date },
): Promise<{ id: string; name: string }> {
  const bytes = Buffer.from(data);
  return prisma.storedFile.upsert({
    where: { kind_name: { kind, name } },
    create: { kind, name, contentType, data: bytes, expiresAt, createdAt },
    update: { contentType, data: bytes, expiresAt, createdAt },
    select: { id: true, name: true },
  });
}

/** A stored file by kind and name, or null when it's gone or expired. */
export async function readStoredFile(
  kind: StoredFileKind,
  name: string,
  now = new Date(),
): Promise<{ id: string; name: string; contentType: string; data: Uint8Array; createdAt: Date } | null> {
  const file = await prisma.storedFile.findUnique({
    where: { kind_name: { kind, name } },
    select: { id: true, name: true, contentType: true, data: true, expiresAt: true, createdAt: true },
  });
  if (!file || (file.expiresAt && file.expiresAt <= now)) return null;
  return { id: file.id, name: file.name, contentType: file.contentType, data: new Uint8Array(file.data), createdAt: file.createdAt };
}

/** The newest file of a kind whose name starts with `prefix`, or null when there's none or it expired. */
export async function findStoredFile(
  kind: StoredFileKind,
  prefix: string,
  now = new Date(),
): Promise<{ name: string; data: Uint8Array } | null> {
  const file = await prisma.storedFile.findFirst({
    where: { kind, name: { startsWith: prefix }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    orderBy: { createdAt: "desc" },
    select: { name: true, data: true },
  });
  return file ? { name: file.name, data: new Uint8Array(file.data) } : null;
}

/** The files of a kind, newest first, without their contents. */
export async function listStoredFiles(kind: StoredFileKind): Promise<{ name: string; createdAt: Date; size: number }[]> {
  const rows = await prisma.$queryRaw<{ name: string; createdAt: Date; size: number }[]>`
    SELECT "name", "createdAt", octet_length("data")::int AS "size"
    FROM "StoredFile" WHERE "kind" = ${kind}
    ORDER BY "createdAt" DESC`;
  return rows;
}

/** Removes one file; nothing happens when it's already gone. */
export async function removeStoredFile(kind: StoredFileKind, name: string): Promise<void> {
  await prisma.storedFile.deleteMany({ where: { kind, name } });
}

/** Removes files of a kind made before `before` (all of them without it); returns how many went. */
export async function removeStoredFiles(kind: StoredFileKind, before?: Date): Promise<number> {
  const { count } = await prisma.storedFile.deleteMany({ where: { kind, ...(before ? { createdAt: { lt: before } } : {}) } });
  return count;
}

/** Removes every file whose time is up. */
export async function removeExpiredFiles(now = new Date()): Promise<number> {
  const { count } = await prisma.storedFile.deleteMany({ where: { expiresAt: { lte: now } } });
  return count;
}
