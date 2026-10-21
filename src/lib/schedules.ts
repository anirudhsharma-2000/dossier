import "server-only";

import { AgentCandidateStatus } from "@/generated/prisma/enums";
import { draftJobKey } from "@/lib/agent/draft";
import { startDueRun } from "@/lib/agent/schedule";
import { lastNightlyBackup, runNightlyBackup } from "@/lib/backup-schedule";
import { scheduledCheck } from "@/lib/google/sync";
import { failStaleJobs, findUnfinishedJobs } from "@/lib/jobs/runner";
import { sweepFinishedJobs } from "@/lib/jobs/retention";
import { logServerError } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { loadSettings } from "@/lib/settings-data";
import { removeExpiredFiles } from "@/lib/stored-files";

// The schedules on Vercel, where no process stays up for the timers a
// long-lived server runs (src/instrumentation.ts). Two things run them:
//
// - the daily Cron Job (vercel.json → /api/cron/daily), which Vercel's free
//   plan allows once a day: the nightly backup and everything below;
// - signed-in page views, at most every few minutes per instance: tidying
//   up, the inbox check when it's due, and the job agent's day's run once
//   its hour has come.
//
// Each step is safe to run twice, so two instances at once do no harm.

const TICK_EVERY_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const globalForTick = globalThis as unknown as { lastTick?: number; lastInboxCheck?: number };

/** Runs one step, logging rather than throwing, so one failure doesn't stop the rest. */
async function step(name: string, work: () => Promise<unknown>): Promise<void> {
  await work().catch((error: unknown) => logServerError(name, error));
}

/** Agent candidates left "drafting" by a function that ran out of time go back to "scored". */
async function resetStuckDrafts(): Promise<void> {
  const drafting = await prisma.agentCandidate.findMany({ where: { status: AgentCandidateStatus.DRAFTING }, select: { id: true } });
  for (const { id } of drafting) {
    if ((await findUnfinishedJobs(draftJobKey(id))).length > 0) continue;
    await prisma.agentCandidate.updateMany({
      where: { id, status: AgentCandidateStatus.DRAFTING },
      data: { status: AgentCandidateStatus.SCORED, error: "Drafting was interrupted. Try again." },
    });
  }
}

/** The inbox check, once its interval (Settings → Google) has passed in this instance. */
async function inboxIfDue(now: number): Promise<void> {
  const minutes = (await loadSettings()).gmailInterval ?? 10;
  if (globalForTick.lastInboxCheck && now - globalForTick.lastInboxCheck < minutes * 60_000) return;
  globalForTick.lastInboxCheck = now;
  await scheduledCheck();
}

/** What a signed-in page view runs on Vercel, at most every few minutes per instance. */
export async function runServerlessTick(now = Date.now()): Promise<void> {
  if (globalForTick.lastTick && now - globalForTick.lastTick < TICK_EVERY_MS) return;
  globalForTick.lastTick = now;
  await step("stale jobs", () => failStaleJobs());
  await step("agent drafts", resetStuckDrafts);
  await step("job sweep", () => sweepFinishedJobs());
  await step("stored files", () => removeExpiredFiles());
  await step("inbox check", () => inboxIfDue(now));
  await step("job agent schedule", () => startDueRun());
  // A missed Cron Job run still gets its backup, a day late at most.
  await step("nightly backup", async () => {
    const last = await lastNightlyBackup();
    if (!last || now - last.getTime() > DAY_MS + 3 * 60 * 60_000) await runNightlyBackup();
  });
}

/** The daily Cron Job: the nightly backup, then the same work as a page view. */
export async function runDailyCron(): Promise<void> {
  await step("nightly backup", () => runNightlyBackup());
  globalForTick.lastTick = undefined;
  await runServerlessTick();
}
