import type { ProfileData } from "@/lib/profile";

import type { FoundLead } from "./types";

// How well a startup fits the profile, 0–100, with the reasons, worked out
// in code so it needs no AI model and costs nothing: the profile's skills
// in what the startup does or asks for, the kind of role, where it is, how
// fresh the news or post is, and whether there's an address to write to.
// Claude can score them more thoughtfully through the connector.

export const MATCH_VERSION = "match@1";

/** Skills too general to say anything about a fit. */
const GENERIC = /^(agile|scrum|kanban|git|github|gitlab|jira|adb|gradle|android studio|vs ?code|ci\/cd( pipelines)?|communication|teamwork|leadership|problem solving|ms office|excel)$/i;

/** Spellings that mean the same place. */
const PLACES: string[][] = [
  ["bengaluru", "bangalore", "blr"],
  ["gurugram", "gurgaon"],
  ["mumbai", "bombay"],
  ["delhi", "new delhi", "ncr", "noida"],
  ["chennai", "madras"],
  ["kolkata", "calcutta"],
];

/** Kinds of work, recognised in the profile and in a startup's text. */
const FIELDS: { name: string; profile: RegExp; lead: RegExp }[] = [
  { name: "mobile", profile: /\b(android|ios|kotlin|swift|jetpack compose|react native|flutter|mobile)\b/i, lead: /\b(android|ios|mobile|kotlin|swift|react native|flutter|app developer|mobile app)\b/i },
  { name: "frontend", profile: /\b(react|next\.?js|vue|angular|typescript|frontend|front-end)\b/i, lead: /\b(frontend|front-end|react|next\.?js|vue|angular|web app)\b/i },
  { name: "backend", profile: /\b(node\.?js|express|django|spring|golang|go|postgres|mongodb|backend|back-end|graphql)\b/i, lead: /\b(backend|back-end|node\.?js|api|platform engineer|distributed systems|golang)\b/i },
  { name: "data and AI", profile: /\b(python|machine learning|ml|pytorch|tensorflow|data science|llm|nlp)\b/i, lead: /\b(machine learning|ml engineer|ai engineer|data scientist|llm|nlp)\b/i },
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A skill as a pattern that matches it as a word, e.g. "Node.js" also as "nodejs". */
function skillPattern(skill: string): RegExp {
  const spelled = escape(skill.toLowerCase()).replace(/\\\.(?=js\b)/, "\\.?").replace(/\s+/g, "[\\s-]?");
  return new RegExp(`(^|[^a-z0-9+#])${spelled}($|[^a-z0-9+#])`, "i");
}

function placeNames(city: string): string[] {
  const name = city.trim().toLowerCase();
  if (!name) return [];
  return PLACES.find((group) => group.includes(name)) ?? [name];
}

const daysAgo = (iso: string | null, now: Date) => (iso ? (now.getTime() - Date.parse(iso)) / 86_400_000 : Infinity);

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export type LeadFit = { score: number; reasons: string[] };

/** How well `lead` fits `profile`, with the reasons in a few words each. */
export function matchLead(lead: FoundLead, profile: ProfileData, now = new Date()): LeadFit {
  const text = [lead.company, lead.summary, lead.details, lead.tags.join(" "), lead.roles.join(" ")].join("\n");
  const reasons: string[] = [];
  let score = 10;

  // The profile's own skills in what the startup does or asks for.
  const skills = profile.skills.map((skill) => skill.name.trim()).filter((name) => name.length > 1 && !GENERIC.test(name));
  const hits = skills.filter((skill) => skillPattern(skill).test(text));
  score += Math.min(40, hits.slice(0, 2).length * 12 + hits.slice(2).length * 5);
  if (hits.length > 0) reasons.push(`Mentions ${list(hits.slice(0, 4))} from your skills`);

  // The kind of work the profile does.
  const profileText = [profile.basics.headline, profile.basics.summary, ...profile.experience.map((role) => role.role), ...skills].join(" ");
  const field = FIELDS.find((entry) => entry.profile.test(profileText) && entry.lead.test(text));
  if (field) {
    score += 15;
    reasons.push(`Does ${field.name} work, like you`);
  } else if (/\b(engineer|developer|engineering)\b/i.test(text)) {
    score += 5;
  }

  // Where it is.
  const where = `${lead.location} ${lead.roles.join(" ")}`;
  const cities = placeNames(profile.basics.city);
  if (cities.some((city) => new RegExp(`\\b${escape(city)}\\b`, "i").test(where))) {
    score += 20;
    reasons.push(`In ${profile.basics.city.trim()}`);
  } else if (/\bindia\b/i.test(where) || (profile.basics.country.trim() && new RegExp(`\\b${escape(profile.basics.country.trim())}\\b`, "i").test(where))) {
    score += 12;
    reasons.push(`In ${profile.basics.country.trim() || "India"}`);
  }
  if (lead.remote) {
    score += 10;
    reasons.push("Hires remotely");
  }

  // How fresh it is: a new post or round means hiring now.
  const age = daysAgo(lead.postedAt, now);
  if (lead.source === "YC") {
    score += 5;
    reasons.push("Hiring now on YC");
  } else if (age <= 14) {
    score += 10;
    const days = Math.max(0, Math.round(age));
    reasons.push(lead.source === "HN" ? "Posted this month" : days === 0 ? "Raised today" : days === 1 ? "Raised yesterday" : `Raised ${days} days ago`);
  } else if (age <= 45) {
    score += 5;
  }

  // Someone to write to.
  if (lead.emails.some((email) => email.label === "Hiring" || email.label === "Founders")) {
    score += 5;
    reasons.push("Has an address for applications");
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}
