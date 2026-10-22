import "server-only";

import type { Lead, Prisma } from "@/generated/prisma/client";
import { LeadStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";

import { findSiteEmails, rankEmails } from "./emails";
import { matchLead, MATCH_VERSION } from "./match";
import { domainOf } from "./text";
import { leadEmailSchema, leadLinkSchema, LEAD_SOURCES, type FoundLead, type LeadEmail, type LeadFilter, type LeadSource, type LeadView } from "./types";

// Leads in the database: kept from refresh to refresh with what the user did
// with them (saved, contacted, dismissed, notes), rescored against the
// profile, and listed for the Startups screen and the Claude connector.

const strings = (value: Prisma.JsonValue | null): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
const emailsOf = (value: Prisma.JsonValue | null): LeadEmail[] => leadEmailSchema.array().catch([]).parse(value ?? []);
const linksOf = (value: Prisma.JsonValue | null) => leadLinkSchema.array().catch([]).parse(value ?? []);

export function leadView(lead: Lead): LeadView {
  return {
    id: lead.id,
    source: (LEAD_SOURCES as readonly string[]).includes(lead.source) ? (lead.source as LeadSource) : "CLAUDE",
    externalId: lead.externalId,
    company: lead.company,
    website: lead.website,
    summary: lead.summary,
    details: lead.details,
    location: lead.location,
    remote: lead.remote,
    stage: lead.stage,
    teamSize: lead.teamSize,
    tags: strings(lead.tags),
    roles: strings(lead.roles),
    emails: emailsOf(lead.emails),
    links: linksOf(lead.links),
    postedAt: lead.postedAt?.toISOString() ?? null,
    score: lead.score,
    reasons: strings(lead.reasons),
    scoredWith: lead.scoredWith,
    status: lead.status,
    emailsCheckedAt: lead.emailsCheckedAt?.toISOString() ?? null,
    notes: lead.notes,
  };
}

/**
 * Keeps what a refresh found: new leads are added, known ones updated (but
 * never their status, notes or the addresses found on their site), and every
 * lead is scored against the profile. Returns how many were new.
 */
export async function upsertLeads(found: FoundLead[], now = new Date()): Promise<number> {
  const profile = await loadProfile();
  const sources = [...new Set(found.map((lead) => lead.source))];
  const existing = new Map(
    (
      await prisma.lead.findMany({
        where: { source: { in: sources } },
        select: { source: true, externalId: true, emails: true, scoredWith: true, website: true },
      })
    ).map((row) => [`${row.source}:${row.externalId}`, row]),
  );
  const seen = new Set<string>();
  const creates: Prisma.LeadCreateManyInput[] = [];
  const updates: Prisma.PrismaPromise<unknown>[] = [];
  for (const lead of found) {
    const key = `${lead.source}:${lead.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const known = existing.get(key);
    const emails = rankEmails([...lead.emails, ...emailsOf(known?.emails ?? null)]);
    const fit = matchLead({ ...lead, emails }, profile, now);
    const fields = {
      company: lead.company.slice(0, 200),
      website: lead.website || known?.website || "",
      summary: lead.summary.slice(0, 1_000),
      details: lead.details,
      location: lead.location.slice(0, 300),
      remote: lead.remote,
      stage: lead.stage.slice(0, 200),
      teamSize: lead.teamSize,
      tags: lead.tags,
      roles: lead.roles,
      emails,
      links: lead.links,
      postedAt: lead.postedAt ? new Date(lead.postedAt) : null,
      seenAt: now,
    };
    const scored = { score: fit.score, reasons: fit.reasons, scoredWith: MATCH_VERSION };
    if (known) {
      // Claude's score stays until the next one; Dossier's own is redone each time.
      const data = known.scoredWith === "claude-chat" ? fields : { ...fields, ...scored };
      updates.push(prisma.lead.update({ where: { source_externalId: { source: lead.source, externalId: lead.externalId } }, data }));
    } else {
      creates.push({ source: lead.source, externalId: lead.externalId, ...fields, ...scored });
    }
  }
  for (let index = 0; index < creates.length; index += 200) {
    await prisma.lead.createMany({ data: creates.slice(index, index + 200), skipDuplicates: true });
  }
  for (let index = 0; index < updates.length; index += 50) {
    await prisma.$transaction(updates.slice(index, index + 50));
  }
  return creates.length;
}

/** Scores every lead again, e.g. after the profile changed. Claude's scores are kept. */
export async function rescoreLeads(now = new Date()): Promise<void> {
  const profile = await loadProfile();
  const leads = await prisma.lead.findMany({ where: { status: { not: LeadStatus.DISMISSED }, scoredWith: { not: "claude-chat" } } });
  for (const lead of leads) {
    const fit = matchLead(leadView(lead), profile, now);
    if (fit.score !== lead.score || JSON.stringify(fit.reasons) !== JSON.stringify(lead.reasons)) {
      await prisma.lead.update({ where: { id: lead.id }, data: { score: fit.score, reasons: fit.reasons, scoredWith: MATCH_VERSION } });
    }
  }
}

/** Looks for the addresses a lead publishes on its site, keeps them, and rescores it. */
export async function findLeadEmails(id: string): Promise<LeadView | null> {
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) return null;
  const view = leadView(lead);
  const found = view.website ? await findSiteEmails(view.website) : [];
  const emails = rankEmails([...view.emails, ...found]);
  const data: Prisma.LeadUpdateInput = { emails, emailsCheckedAt: new Date() };
  if (lead.scoredWith !== "claude-chat") {
    const fit = matchLead({ ...view, emails }, await loadProfile());
    Object.assign(data, { score: fit.score, reasons: fit.reasons, scoredWith: MATCH_VERSION });
  }
  return leadView(await prisma.lead.update({ where: { id }, data }));
}

const SAME_PLACE: Record<string, RegExp> = {
  bengaluru: /\b(bengaluru|bangalore)\b/i,
  bangalore: /\b(bengaluru|bangalore)\b/i,
};

/** Whether a lead is where the filter asks. */
function inPlace(lead: LeadView, place: LeadFilter["place"], city: string): boolean {
  const where = `${lead.location} ${lead.roles.join(" ")}`;
  if (place === "remote") return lead.remote === true;
  if (place === "india") return /\b(india|bengaluru|bangalore|mumbai|delhi|gurgaon|gurugram|noida|hyderabad|pune|chennai)\b/i.test(where) || lead.source === "INC42";
  if (place === "city") {
    const name = city.trim().toLowerCase();
    return Boolean(name) && (SAME_PLACE[name] ?? new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")).test(where);
  }
  return true;
}

export type LeadList = { leads: LeadView[]; total: number; counts: Record<LeadStatus, number> };

/** The leads a filter asks for, best match or newest first, at most `limit`. */
export async function listLeads(filter: LeadFilter, { limit = 100, city = "" }: { limit?: number; city?: string } = {}): Promise<LeadList> {
  const [rows, grouped] = await Promise.all([
    prisma.lead.findMany({
      where: {
        status: filter.status,
        ...(filter.source ? { source: filter.source } : {}),
        ...(filter.minScore > 0 ? { score: { gte: filter.minScore } } : {}),
      },
      orderBy: filter.sort === "newest" ? [{ postedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }] : [{ score: "desc" }, { postedAt: { sort: "desc", nulls: "last" } }],
    }),
    prisma.lead.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const words = filter.q.toLowerCase().split(/\s+/).filter(Boolean);
  const matching = rows.map(leadView).filter((lead) => {
    if (filter.withEmail && lead.emails.length === 0) return false;
    if (!inPlace(lead, filter.place, city)) return false;
    if (words.length === 0) return true;
    const text = [lead.company, lead.summary, lead.details, lead.location, lead.stage, ...lead.tags, ...lead.roles].join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const counts = { NEW: 0, SAVED: 0, CONTACTED: 0, DISMISSED: 0 } as Record<LeadStatus, number>;
  for (const group of grouped) counts[group.status] = group._count._all;
  return { leads: matching.slice(0, limit), total: matching.length, counts };
}

export async function getLead(id: string): Promise<LeadView | null> {
  const lead = await prisma.lead.findUnique({ where: { id } });
  return lead ? leadView(lead) : null;
}

/** Saves what the user or Claude changed: status, notes, the site, addresses found, a score. */
export async function updateLead(
  id: string,
  change: { status?: LeadStatus; notes?: string; website?: string; emails?: LeadEmail[]; score?: { score: number; reasons: string[] } },
): Promise<LeadView | null> {
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) return null;
  const data: Prisma.LeadUpdateInput = {};
  if (change.status) data.status = change.status;
  if (change.notes !== undefined) data.notes = change.notes.slice(0, 5_000);
  if (change.website !== undefined && (!change.website || domainOf(change.website))) data.website = change.website;
  if (change.emails) data.emails = rankEmails([...emailsOf(lead.emails), ...change.emails]);
  if (change.score) Object.assign(data, { score: change.score.score, reasons: change.score.reasons, scoredWith: "claude-chat" });
  return leadView(await prisma.lead.update({ where: { id }, data }));
}

/** Leads nobody did anything with and no refresh found for this long are removed. */
const STALE_DAYS = 45;

export async function pruneLeads(now = new Date()): Promise<number> {
  const { count } = await prisma.lead.deleteMany({
    where: { status: LeadStatus.NEW, seenAt: { lt: new Date(now.getTime() - STALE_DAYS * 86_400_000) } },
  });
  return count;
}

