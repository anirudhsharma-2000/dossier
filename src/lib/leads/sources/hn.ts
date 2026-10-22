import "server-only";

import { z } from "zod";

import { getJson, SourceError } from "../http";
import { emailLabel, findEmails, firstLine, firstLink, htmlToText } from "../text";
import type { FoundLead } from "../types";

// Hacker News "Ask HN: Who is hiring?" (https://news.ycombinator.com), the
// monthly thread where companies, often startups, post their open roles,
// many with an address to write to. Read through HN's public Algolia API.
// Posts for India or remote work are kept; ones only for elsewhere aren't.

const SEARCH_URL = "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10";
const itemUrl = (id: string | number) => `https://hn.algolia.com/api/v1/items/${id}`;
export const hnLink = (id: string | number) => `https://news.ycombinator.com/item?id=${id}`;

const searchSchema = z.object({
  hits: z.array(z.object({ objectID: z.string(), title: z.string().nullish(), created_at: z.string().nullish() })),
});
const commentSchema = z.object({
  id: z.union([z.number(), z.string()]),
  author: z.string().nullish(),
  text: z.string().nullish(),
  created_at: z.string().nullish(),
});
const threadSchema = z.object({ children: z.array(z.unknown()) });

const INDIA = /\b(india|bengaluru|bangalore|mumbai|delhi|ncr|gurgaon|gurugram|noida|hyderabad|pune|chennai|apac|asia)\b/i;
const REMOTE = /\bremote\b/i;
/** Remote, but only for people elsewhere. */
const REMOTE_ELSEWHERE = /remote[^|\n]{0,40}\b(us|u\.s\.|usa|united states|canada|eu|europe|uk|americas|north america|latam|us[- ]only|us timezones?|est|pst|cet)\b/i;
const ROLE = /\b(engineer|developer|programmer|architect|designer|scientist|manager|lead|head of|founding|sre|devops|intern|analyst)\b/i;

/** "Acme | Senior Android Engineer | Bengaluru or REMOTE | Full-time": the post's first line, in parts. */
function headerParts(text: string): string[] {
  const header = firstLine(text, 400);
  return header
    .split(/\s+[|•·—–]\s+|\s+-\s+|\s*\|\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** A "Who is hiring" post as a lead, or null when it's not one someone in India could take. */
export function leadFromHnPost(comment: z.output<typeof commentSchema>): FoundLead | null {
  if (!comment.text) return null;
  const text = htmlToText(comment.text);
  const parts = headerParts(text);
  const company = parts[0]?.replace(/\s*\(.*\)$/, "").replace(/^\W+|\W+$/g, "").slice(0, 120);
  if (!company || company.length < 2) return null;
  const header = parts.join(" | ");
  const india = INDIA.test(header);
  const remote = REMOTE.test(header);
  const remoteElsewhere = remote && REMOTE_ELSEWHERE.test(header) && !/\b(anywhere|worldwide|global)\b/i.test(header);
  if (!india && !(remote && !remoteElsewhere)) return null;

  const link = hnLink(comment.id);
  const site = firstLink(text);
  return {
    source: "HN",
    externalId: String(comment.id),
    company,
    website: site ? new URL(site).origin : "",
    summary: firstLine(text.split("\n").slice(1).join("\n")) || header,
    details: text.slice(0, 20_000),
    location: parts.filter((part) => INDIA.test(part) || REMOTE.test(part) || /onsite|hybrid/i.test(part)).join(" · ").slice(0, 200),
    remote: remote ? true : india ? false : null,
    // A round named in the header, else the YC batch in the company's brackets: "Tiller (YC W24)".
    stage: parts.slice(1).find((part) => /^(pre-seed|seed|series [a-e]|bootstrapped|profitable)\b/i.test(part)) ?? /\((yc [wsfx]\d{2})\)/i.exec(parts[0])?.[1] ?? "",
    teamSize: null,
    tags: [],
    roles: parts.filter((part) => ROLE.test(part) && part.length < 160).slice(0, 6),
    emails: findEmails(text).map((email) => ({ email, label: emailLabel(email) === "Person" ? "Hiring" : emailLabel(email), from: link })),
    links: [{ label: "Hiring post", url: link }, ...(site ? [{ label: "Link in the post", url: site }] : [])],
    postedAt: comment.created_at ?? null,
  };
}

/** This month's "Who is hiring" posts that suit someone in India. */
export async function fetchHnLeads(signal?: AbortSignal): Promise<FoundLead[]> {
  const search = searchSchema.safeParse(await getJson(SEARCH_URL, { signal }));
  if (!search.success) throw new SourceError("changed its format");
  const thread = search.data.hits.find((hit) => /^ask hn: who is hiring\?/i.test(hit.title ?? ""));
  if (!thread) throw new SourceError("has no hiring thread this month");
  const answer = threadSchema.safeParse(await getJson(itemUrl(thread.objectID), { signal }));
  if (!answer.success) throw new SourceError("changed its format");
  const leads: FoundLead[] = [];
  for (const child of answer.data.children) {
    const comment = commentSchema.safeParse(child);
    if (!comment.success) continue;
    const lead = leadFromHnPost(comment.data);
    if (lead) leads.push(lead);
  }
  return leads;
}
