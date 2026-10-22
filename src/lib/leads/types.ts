import { z } from "zod";

// Startups (the Startups screen): companies worth reaching out to, found in
// YC's list of companies hiring, Hacker News "Who is hiring" and funding
// news, ranked against the profile, with the contact emails they publish.
// Shared by the server, the screen and the Claude connector.

export const LEAD_SOURCES = ["YC", "HN", "INC42", "TECHCRUNCH", "CLAUDE"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_SOURCE_INFO: Record<LeadSource, { name: string; kind: string }> = {
  YC: { name: "Y Combinator", kind: "Hiring now" },
  HN: { name: "Hacker News", kind: "Who is hiring" },
  INC42: { name: "Inc42", kind: "Just raised" },
  TECHCRUNCH: { name: "TechCrunch", kind: "Just raised" },
  CLAUDE: { name: "Claude", kind: "Added in Claude" },
};

export const LEAD_STATUSES = ["NEW", "SAVED", "CONTACTED", "DISMISSED"] as const;
export type LeadStatusName = (typeof LEAD_STATUSES)[number];

export const leadEmailSchema = z.object({
  email: z.string().email().max(200),
  /** "Hiring", "Founders", "General" or what the source called it. */
  label: z.string().max(60).default("General"),
  /** Where it was published: a page, a post or "Claude". */
  from: z.string().max(500).default(""),
});
export type LeadEmail = z.infer<typeof leadEmailSchema>;

export const leadLinkSchema = z.object({ label: z.string().max(60), url: z.string().url().max(2000) });
export type LeadLink = z.infer<typeof leadLinkSchema>;

/** A startup as a source found it. */
export type FoundLead = {
  source: LeadSource;
  externalId: string;
  company: string;
  website: string;
  summary: string;
  details: string;
  location: string;
  remote: boolean | null;
  stage: string;
  teamSize: number | null;
  tags: string[];
  roles: string[];
  emails: LeadEmail[];
  links: LeadLink[];
  postedAt: string | null;
};

/** A lead as the screen and Claude see it. */
export type LeadView = FoundLead & {
  id: string;
  score: number;
  reasons: string[];
  scoredWith: string;
  status: LeadStatusName;
  emailsCheckedAt: string | null;
  notes: string;
};

/** Where to look: anywhere, the profile's city, India, or remote. */
export const LEAD_PLACES = ["any", "city", "india", "remote"] as const;
export type LeadPlace = (typeof LEAD_PLACES)[number];

export const LEAD_SORTS = ["match", "newest"] as const;

export const leadFilterSchema = z.object({
  q: z.string().trim().max(200).default(""),
  place: z.enum(LEAD_PLACES).default("any"),
  source: z.enum(LEAD_SOURCES).or(z.literal("")).default(""),
  minScore: z.coerce.number().int().min(0).max(100).default(0),
  withEmail: z.boolean().default(false),
  status: z.enum(LEAD_STATUSES).default("NEW"),
  sort: z.enum(LEAD_SORTS).default("match"),
});
export type LeadFilter = z.output<typeof leadFilterSchema>;

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

/** The filter in the Startups screen's URL. */
export function leadFilterFromParams(params: Record<string, string | string[] | undefined>): LeadFilter {
  const parsed = leadFilterSchema.safeParse({
    q: one(params.q),
    place: one(params.place) || undefined,
    source: one(params.source),
    minScore: one(params.min) || undefined,
    withEmail: one(params.email) === "1",
    status: one(params.view).toUpperCase() || undefined,
    sort: one(params.sort) || undefined,
  });
  return parsed.success ? parsed.data : leadFilterSchema.parse({});
}

/** The Startups screen's URL for a filter, leaving out the defaults. */
export function leadFilterHref(filter: LeadFilter): string {
  const params = new URLSearchParams();
  if (filter.q) params.set("q", filter.q);
  if (filter.place !== "any") params.set("place", filter.place);
  if (filter.source) params.set("source", filter.source);
  if (filter.minScore > 0) params.set("min", String(filter.minScore));
  if (filter.withEmail) params.set("email", "1");
  if (filter.status !== "NEW") params.set("view", filter.status.toLowerCase());
  if (filter.sort !== "match") params.set("sort", filter.sort);
  const query = params.toString();
  return query ? `/startups?${query}` : "/startups";
}
