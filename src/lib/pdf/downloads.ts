import "server-only";

import { randomUUID } from "node:crypto";

import { contentDisposition } from "@/lib/file-name";
import { findStoredFile, removeExpiredFiles, storeFile } from "@/lib/stored-files";

// Rendered PDFs waiting to be downloaded. The download button has the server
// render first, so it can say it's busy and show errors, then lets the
// browser fetch the file from its own link: a file made inside the page
// saved empty in Chrome and Edge on Windows when they asked where to save.
// Held a few minutes rather than once, in case a browser asks twice. They
// wait in the database, so the request that fetches one may reach another
// instance of the app than the one that rendered it (Vercel).

/** How long a rendered PDF waits for its download. */
export const HOLD_MS = 5 * 60_000;

/** Keeps a rendered PDF for its download; returns the id to fetch it by. */
export async function holdPdf(pdf: Uint8Array, fileName: string, now = Date.now()): Promise<string> {
  await removeExpiredFiles(new Date(now)).catch(() => 0);
  const id = randomUUID();
  // Stored as "<id>/<file name>": the id finds it, the name names the download.
  await storeFile("pdf", `${id}/${fileName}`, pdf, { contentType: "application/pdf", expiresAt: new Date(now + HOLD_MS), createdAt: new Date(now) });
  return id;
}

/** A held PDF, or null once it has expired. */
export async function heldPdf(id: string, now = Date.now()): Promise<{ pdf: Uint8Array; fileName: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const file = await findStoredFile("pdf", `${id}/`, new Date(now));
  return file ? { pdf: file.data, fileName: file.name.slice(id.length + 1) } : null;
}

/** A PDF as a download named `fileName`. */
export function pdfDownload(pdf: Uint8Array, fileName: string): Response {
  return new Response(Buffer.from(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": contentDisposition(fileName),
    },
  });
}
