import "server-only";

import { z } from "zod";

import { defineJob, findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { logServerError } from "@/lib/log";
import { prisma } from "@/lib/prisma";

import { SourceError } from "./http";
import { fetchHnLeads } from "./sources/hn";
import { fetchNewsLeads, NEWS_FEEDS } from "./sources/news";
import { fetchYcLeads } from "./sources/yc";
import { findLeadEmails, pruneLeads, upsertLeads } from "./store";
import { LEAD_SOURCE_INFO, type FoundLead, type LeadSource } from "./types";

// "Refresh" on the Startups screen, and once a day on its own: asks every
// source what's new, keeps it, scores it, and looks for the contact
// addresses of the best new matches on their own sites. One source failing
// doesn't stop the others; what happened is kept for the screen.

export const LEADS_JOB_KEY = "leads-refresh";
const LAST_REFRESH = "leadsLastRefresh";
/** Sites checked for addresses per refresh: the best matches without any yet. */
const EMAIL_LOOKUPS = 12;
const EMAIL_CONCURRENCY = 4;

const sourceResult = z.object({ source: z.string(), found: z.number().int(), error: z.string().nullable() });
const refreshResult = z.object({ at: z.string(), added: z.number().int(), sources: z.array(sourceResult), emailsFound: z.number().int() });
export type RefreshResult = z.infer<typeof refreshResult>;

/** What the last refresh found, for the screen; null before the first. */
export async function lastRefresh(): Promise<RefreshResult | null> {
  const row = await prisma.setting.findUnique({ where: { key: LAST_REFRESH } });
  if (!row) return null;
  try {
    return refreshResult.parse(JSON.parse(row.value));
  } catch {
    return null;
  }
}

const SOURCES: { source: LeadSource; fetch: (signal: AbortSignal) => Promise<FoundLead[]> }[] = [
  { source: "YC", fetch: fetchYcLeads },
  { source: "HN", fetch: fetchHnLeads },
  ...NEWS_FEEDS.map((feed) => ({ source: feed.source, fetch: (signal: AbortSignal) => fetchNewsLeads(feed, signal) })),
];

/** Runs every source, keeps what they found, and looks up addresses for the best new leads. */
export async function refreshLeads(step: (name: string) => Promise<void> = async () => {}, signal: AbortSignal = new AbortController().signal): Promise<RefreshResult> {
  const now = new Date();
  await step("Asking Y Combinator, Hacker News, Inc42 and TechCrunch");
  const results = await Promise.allSettled(SOURCES.map((entry) => entry.fetch(signal)));
  const sources = results.map((result, index) => {
    const { source } = SOURCES[index];
    if (result.status === "fulfilled") return { source, found: result.value.length, error: null };
    const reason = result.reason instanceof SourceError ? result.reason.message : "failed";
    if (!(result.reason instanceof SourceError)) logServerError(`startups: ${source}`, result.reason);
    return { source, found: 0, error: `${LEAD_SOURCE_INFO[source].name} ${reason}` };
  });
  const found = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));

  await step(`Scoring ${found.length} startups against your profile`);
  const added = await upsertLeads(found, now);
  await pruneLeads(now);

  await step("Looking for contact addresses on their sites");
  const toCheck = await prisma.lead.findMany({
    where: { status: { in: ["NEW", "SAVED"] }, emailsCheckedAt: null, website: { not: "" } },
    orderBy: { score: "desc" },
    take: EMAIL_LOOKUPS,
    select: { id: true, emails: true },
  });
  let emailsFound = 0;
  for (let index = 0; index < toCheck.length; index += EMAIL_CONCURRENCY) {
    signal.throwIfAborted();
    const batch = toCheck.slice(index, index + EMAIL_CONCURRENCY);
    const checked = await Promise.allSettled(batch.map((lead) => findLeadEmails(lead.id)));
    checked.forEach((result, position) => {
      const before = Array.isArray(batch[position].emails) ? (batch[position].emails as unknown[]).length : 0;
      if (result.status === "fulfilled" && result.value && result.value.emails.length > before) emailsFound += 1;
    });
  }

  const result: RefreshResult = { at: now.toISOString(), added, sources, emailsFound };
  await prisma.setting.upsert({ where: { key: LAST_REFRESH }, create: { key: LAST_REFRESH, value: JSON.stringify(result) }, update: { value: JSON.stringify(result) } });
  return result;
}

export const refreshLeadsJob = defineJob({
  type: "leads-refresh",
  input: z.object({}),
  result: refreshResult,
  run: (_input, { step, signal }) => refreshLeads(step, signal),
});

/** Starts a refresh unless one is under way; returns its job. */
export async function startLeadsRefresh(): Promise<string> {
  const [running] = await findUnfinishedJobs(LEADS_JOB_KEY);
  return running?.id ?? startJob(refreshLeadsJob, {}, { key: LEADS_JOB_KEY });
}

/** Whether the last refresh was over a day ago (or never ran). */
export async function refreshDue(now = new Date()): Promise<boolean> {
  const last = await lastRefresh();
  return !last || now.getTime() - Date.parse(last.at) > 22 * 60 * 60 * 1000;
}
