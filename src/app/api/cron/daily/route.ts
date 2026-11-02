import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { runDailyCron } from "@/lib/schedules";

// The daily Cron Job on Vercel (vercel.json): the nightly backup, tidying up
// and the job agent's run, which a long-lived server does with timers.
// Vercel sends CRON_SECRET as a bearer token; without it set, nothing runs.

export const maxDuration = 300;

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  await runDailyCron();
  return NextResponse.json({ ok: true });
}
