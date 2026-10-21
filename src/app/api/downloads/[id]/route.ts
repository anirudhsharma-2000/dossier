import { NextResponse } from "next/server";

import { contentDisposition } from "@/lib/file-name";
import { getJob } from "@/lib/jobs/runner";
import { zipPdfsJob } from "@/lib/jobs/zip-pdfs";
import { route } from "@/lib/route";
import { readStoredFile, removeStoredFile } from "@/lib/stored-files";

const GONE = "That download isn't here any more. Start a new one from Settings → Your data.";

/** Hands over a finished "Download all PDFs" zip (E10-5) once, then removes it from the server. */
export const GET = route<RouteContext<"/api/downloads/[id]">>(async (_request, { params }) => {
  const { id } = await params;
  const job = await getJob(id);
  const result = job?.type === zipPdfsJob.type && job.status === "DONE" ? zipPdfsJob.result.safeParse(job.result) : null;
  if (!result?.success) return NextResponse.json({ error: GONE }, { status: 404 });

  const zip = await readStoredFile("download", result.data.file);
  if (!zip) return NextResponse.json({ error: GONE }, { status: 410 });
  await removeStoredFile("download", result.data.file).catch(() => {});
  return new Response(Buffer.from(zip.data), {
    headers: { "content-type": "application/zip", "content-disposition": contentDisposition(result.data.fileName) },
  });
});
