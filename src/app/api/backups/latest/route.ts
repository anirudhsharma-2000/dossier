import { NextResponse } from "next/server";

import { listBackups } from "@/lib/backups";
import { contentDisposition } from "@/lib/file-name";
import { route } from "@/lib/route";
import { readStoredFile } from "@/lib/stored-files";

/**
 * Downloads the newest backup (nightly or from before an import). Backups
 * live in the database, so there's no folder on a server to copy them from.
 */
export const GET = route(async () => {
  const [latest] = await listBackups();
  const file = latest ? await readStoredFile("backup", latest.name) : null;
  if (!file) return NextResponse.json({ error: "There's no backup yet." }, { status: 404 });
  return new Response(Buffer.from(file.data), {
    headers: { "content-type": "application/json", "content-disposition": contentDisposition(file.name) },
  });
});
