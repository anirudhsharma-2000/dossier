import { NextResponse } from "next/server";

import { heldPdf, pdfDownload } from "@/lib/pdf/downloads";
import { route } from "@/lib/route";

const GONE = "That PDF isn't here any more. Download it again.";

/** Hands over a PDF that `POST /api/pdf` rendered and held for a few minutes. */
export const GET = route<RouteContext<"/api/pdf/[id]">>(async (_request, { params }) => {
  const held = await heldPdf((await params).id);
  return held ? pdfDownload(held.pdf, held.fileName) : NextResponse.json({ error: GONE }, { status: 404 });
});
