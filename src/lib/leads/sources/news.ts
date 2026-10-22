import "server-only";

import { getText, SourceError } from "../http";
import { decodeEntities, htmlToText } from "../text";
import type { FoundLead, LeadSource } from "../types";

// Funding news: startups that just raised money are usually about to hire.
// Inc42 covers Indian startups; TechCrunch's fundraising section the rest.
// Only headlines that announce a round are kept, with the company's name
// read from the headline ("Enterprise AI Startup AuxoAI Nets $20.7M…").

export const NEWS_FEEDS: { source: Extract<LeadSource, "INC42" | "TECHCRUNCH">; url: string; location: string }[] = [
  { source: "INC42", url: "https://inc42.com/buzz/feed/", location: "India" },
  { source: "TECHCRUNCH", url: "https://techcrunch.com/category/fundraising/feed/", location: "" },
];

const RAISE = /\s(raises|raised|nets|bags|secures|lands|closes|gets|grabs|picks up|scores|snags)\s+(?:a\s+|an\s+|its\s+)?(?:\$|₹|rs\.?\s*|inr\s*|usd\s*|€|£)?\s*[\d.,]+\s*(?:mn|m|million|bn|b|billion|cr|crore|lakh|k)?\b|\s(raises|nets|bags|secures|closes)\s+[^,]{0,40}\b(round|funding|seed|series [a-e])\b/i;
/** Words before the name in "Peak XV-Backed AI Startup Blacksmith Nets…". */
const DESCRIBED = /^.*?\b(?:startup|start-up|company|platform|firm|maker|provider|unicorn|player|brand|app|marketplace|fintech|edtech|healthtech|saas|d2c)\s+(?=[A-Z0-9])/i;
/** "SpaceX alum's aviation startup, Reliable Robotics, lands…". */
const APPOSITION = /,\s*([^,]{2,60}),\s*$/;

/** The company in a funding headline, or null when the headline isn't about a round. */
export function companyFromHeadline(title: string): { company: string; round: string } | null {
  const match = RAISE.exec(` ${title}`);
  if (!match) return null;
  let before = ` ${title}`.slice(0, match.index).trim();
  const apposed = APPOSITION.exec(before);
  if (apposed) before = apposed[1];
  else before = before.replace(DESCRIBED, "");
  before = before.replace(/^(exclusive|breaking|funding alert)\s*:\s*/i, "").replace(/['’]s$/, "").trim();
  if (!before || before.length > 60 || before.split(/\s+/).length > 6) return null;
  const round = /\b(pre-seed|seed|series [a-e]|bridge|pre-series [a-e])\b/i.exec(title)?.[0] ?? "";
  const amount = /(?:\$|₹|rs\.?\s*|inr\s*|€|£)?\s*[\d.,]+\s*(?:mn|m|million|bn|b|billion|cr|crore)\b/i.exec(title.slice(match.index))?.[0]?.trim() ?? "";
  return { company: before, round: [round && round.replace(/\b\w/g, (letter) => letter.toUpperCase()), amount && `raised ${amount}`].filter(Boolean).join(" · ") };
}

type Item = { title: string; link: string; pubDate: string; description: string; categories: string[] };

/** The items of an RSS 2.0 feed. */
export function rssItems(xml: string): Item[] {
  const tag = (block: string, name: string) => decodeEntities((new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block)?.[1] ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(([block]) => ({
    title: tag(block, "title"),
    link: tag(block, "link"),
    pubDate: tag(block, "pubDate"),
    description: tag(block, "description"),
    categories: [...block.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map(([, value]) => decodeEntities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim()),
  }));
}

export function leadFromNewsItem(item: Item, feed: (typeof NEWS_FEEDS)[number]): FoundLead | null {
  const found = companyFromHeadline(item.title);
  if (!found || !/^https?:\/\//i.test(item.link)) return null;
  const posted = Date.parse(item.pubDate);
  const text = htmlToText(item.description);
  return {
    source: feed.source,
    externalId: item.link.slice(0, 500),
    company: found.company,
    website: "",
    summary: item.title,
    details: text.slice(0, 5_000),
    location: feed.location,
    remote: null,
    stage: found.round,
    teamSize: null,
    tags: item.categories.filter((category) => !/^(buzz|funding|fundraising|startups?|news)$/i.test(category)).slice(0, 8),
    roles: [],
    emails: [],
    links: [{ label: "The news", url: item.link }],
    postedAt: Number.isNaN(posted) ? null : new Date(posted).toISOString(),
  };
}

/** Startups that just announced a round, from each feed. */
export async function fetchNewsLeads(feed: (typeof NEWS_FEEDS)[number], signal?: AbortSignal): Promise<FoundLead[]> {
  const xml = await getText(feed.url, { signal });
  if (!/<rss\b|<channel\b/i.test(xml)) throw new SourceError("isn't an RSS feed any more");
  return rssItems(xml).flatMap((item) => leadFromNewsItem(item, feed) ?? []);
}

