import "server-only";

import { z } from "zod";

import { getJson, SourceError } from "../http";
import { firstLine } from "../text";
import type { FoundLead } from "../types";

// Y Combinator's companies that are hiring now, from the yc-oss mirror of
// YC's public directory (https://github.com/yc-oss/api), updated daily.
// Only companies in India, or hiring remotely, are kept.

export const YC_HIRING_URL = "https://yc-oss.github.io/api/companies/hiring.json";

const text = z.string().nullish().catch(null);
const company = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().min(1),
  slug: z.string().min(1),
  website: text,
  one_liner: text,
  long_description: text,
  team_size: z.number().nullish().catch(null),
  industries: z.array(z.string()).nullish().catch(null),
  tags: z.array(z.string()).nullish().catch(null),
  regions: z.array(z.string()).nullish().catch(null),
  all_locations: text,
  batch: text,
  stage: text,
  status: text,
  isHiring: z.boolean().nullish().catch(null),
  launched_at: z.number().nullish().catch(null),
  url: text,
});
type Company = z.output<typeof company>;

const INDIA = /\b(india|bengaluru|bangalore|mumbai|delhi|gurgaon|gurugram|noida|hyderabad|pune|chennai|south asia)\b/i;

/** Whether a company might hire someone in India: based there, or hiring remotely. */
export function ycReachable(entry: Pick<Company, "regions" | "all_locations">): { india: boolean; remote: boolean } {
  const regions = entry.regions ?? [];
  const india = INDIA.test(entry.all_locations ?? "") || regions.some((region) => INDIA.test(region));
  const remote = regions.some((region) => /remote/i.test(region));
  return { india, remote };
}

/** "W24" from "Winter 2024". */
function shortBatch(batch: string | null | undefined): string {
  const match = /^(winter|summer|spring|fall)\s+(\d{4})$/i.exec(batch?.trim() ?? "");
  return match ? `${match[1][0].toUpperCase()}${match[2].slice(2)}` : (batch?.trim() ?? "");
}

export function leadFromYc(entry: Company): FoundLead {
  const { india, remote } = ycReachable(entry);
  const url = entry.url || `https://www.ycombinator.com/companies/${entry.slug}`;
  const website = /^https?:\/\//i.test(entry.website ?? "") ? entry.website!.trim() : "";
  return {
    source: "YC",
    externalId: entry.slug,
    company: entry.name.trim(),
    website,
    summary: (entry.one_liner ?? "").trim() || firstLine(entry.long_description ?? ""),
    details: (entry.long_description ?? "").trim().slice(0, 20_000),
    location: (entry.all_locations ?? "").trim() || (remote ? "Remote" : ""),
    remote: remote || (india ? false : null),
    stage: [shortBatch(entry.batch) && `YC ${shortBatch(entry.batch)}`, entry.stage?.trim()].filter(Boolean).join(" · "),
    teamSize: entry.team_size ?? null,
    tags: [...new Set([...(entry.industries ?? []), ...(entry.tags ?? [])])].slice(0, 12),
    roles: [],
    emails: [],
    links: [
      ...(website ? [{ label: "Website", url: website }] : []),
      { label: "YC profile", url },
      { label: "Open roles", url: `${url.replace(/\/$/, "")}/jobs` },
    ],
    postedAt: entry.launched_at ? new Date(entry.launched_at * 1000).toISOString() : null,
  };
}

/** YC companies hiring now that are in India or hire remotely. */
export async function fetchYcLeads(signal?: AbortSignal): Promise<FoundLead[]> {
  const answer = await getJson(YC_HIRING_URL, { signal });
  if (!Array.isArray(answer)) throw new SourceError("changed its format");
  const leads: FoundLead[] = [];
  for (const item of answer) {
    const parsed = company.safeParse(item);
    if (!parsed.success || parsed.data.isHiring === false || /inactive|acquired/i.test(parsed.data.status ?? "")) continue;
    const { india, remote } = ycReachable(parsed.data);
    if (india || remote) leads.push(leadFromYc(parsed.data));
  }
  return leads;
}
