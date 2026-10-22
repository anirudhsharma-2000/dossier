"use server";

import { z } from "zod";

import { LeadStatus } from "@/generated/prisma/enums";
import { action, ActionError } from "@/lib/action";
import { claudeChatUrl } from "@/lib/connector/handoff";
import { startLeadsRefresh } from "@/lib/leads/refresh";
import { findLeadEmails, getLead, updateLead } from "@/lib/leads/store";

const leadId = z.string().min(1).max(64);
const GONE = "That startup is no longer in the list. Refresh it.";

/** "Refresh": asks every source again, in the background; returns the job to follow. */
export const refreshStartups = action(z.object({}), async () => ({ jobId: await startLeadsRefresh() }));

/** Save, Mark contacted, Dismiss and their undo. */
export const setStartupStatus = action(z.object({ id: leadId, status: z.enum(LeadStatus) }), async ({ id, status }) => {
  const lead = await updateLead(id, { status });
  if (!lead) throw new ActionError(GONE);
  return { status: lead.status };
});

/** "Find emails": looks on the startup's own site for the addresses it publishes. */
export const findStartupEmails = action(z.object({ id: leadId }), async ({ id }) => {
  const lead = await findLeadEmails(id);
  if (!lead) throw new ActionError(GONE);
  return { emails: lead.emails, score: lead.score, reasons: lead.reasons, emailsCheckedAt: lead.emailsCheckedAt };
});

/** Notes on a startup, kept as typed. */
export const saveStartupNotes = action(z.object({ id: leadId, notes: z.string().max(5_000) }), async ({ id, notes }) => {
  if (!(await updateLead(id, { notes }))) throw new ActionError(GONE);
  return null;
});

/**
 * "Write the email with Claude": a claude.ai chat, on the user's own Claude
 * plan, that reads the startup and the profile through the Dossier connector
 * and writes a short email to them. Nothing is sent from Dossier.
 */
export const writeStartupEmail = action(z.object({ id: leadId }), async ({ id }) => {
  const lead = await getLead(id);
  if (!lead) throw new ActionError(GONE);
  const prompt =
    `Using my Dossier connector: read the startup with lead_id "${lead.id}" (${lead.company}) with get_startup and my profile with get_profile. ` +
    "If it has no contact address, look on its website for one it publishes. " +
    "Then write a short, specific cold email (under 150 words) asking about engineering roles, saying what I could do for them from facts in my profile only, " +
    "with a subject line, and tell me which address to send it to. Once I say I've sent it, mark it contacted with update_startup.";
  return { url: claudeChatUrl(prompt) };
});
