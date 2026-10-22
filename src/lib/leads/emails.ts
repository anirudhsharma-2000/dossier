import "server-only";

import { fetchHtml } from "@/lib/posting-fetch";

import { domainOf, emailLabel, emailOnDomain, findEmails } from "./text";
import type { LeadEmail } from "./types";

// The contact addresses a startup publishes on its own site: its home page
// and the usual careers, jobs, about and contact pages. Only addresses on
// the startup's own domain are kept, and nothing is guessed: Dossier shows
// what the company chose to publish. Pages are fetched with the same guards
// as a job posting (public addresses only, limited time and size).

const PAGES = ["", "/careers", "/jobs", "/about", "/contact", "/team"];
const PAGE_TIMEOUT_MS = 8_000;

/** Hiring addresses first, then founders, people, and general ones. */
const ORDER = ["Hiring", "Founders", "Person", "General"];

export function rankEmails(emails: LeadEmail[]): LeadEmail[] {
  const seen = new Set<string>();
  return emails
    .filter((entry) => !seen.has(entry.email) && Boolean(seen.add(entry.email)))
    .sort((a, b) => ORDER.indexOf(a.label) - ORDER.indexOf(b.label));
}

/** The addresses on a startup's own pages; empty when it publishes none or can't be reached. */
export async function findSiteEmails(website: string): Promise<LeadEmail[]> {
  const domain = domainOf(website);
  if (!domain) return [];
  const origin = new URL(website).origin;
  const results = await Promise.allSettled(
    PAGES.map(async (path) => {
      const page = await fetchHtml(`${origin}${path}`, { timeoutMs: PAGE_TIMEOUT_MS });
      if (!page.ok) return [];
      // A page that redirected to another site isn't the startup's.
      if (!emailOnDomain(`x@${domainOf(page.url)}`, domain)) return [];
      const mailto = [...page.html.matchAll(/mailto:([^"'?\s>]+)/gi)].map(([, address]) => decodeURIComponent(address));
      return [...findEmails(mailto.join(" ")), ...findEmails(page.html.replace(/<[^>]+>/g, " "))]
        .filter((email) => emailOnDomain(email, domain))
        .map((email) => ({ email, label: emailLabel(email), from: page.url }));
    }),
  );
  return rankEmails(results.flatMap((result) => (result.status === "fulfilled" ? result.value : []))).slice(0, 8);
}
