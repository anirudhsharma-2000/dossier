import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ApplicationStatus, DocumentKind } from "@/generated/prisma/enums";
import { approveCandidate } from "@/lib/agent/draft";
import { isAiUsable } from "@/lib/ai/config";
import { scoreFrom } from "@/lib/ai/tasks/score-posting";
import { unitsSchema } from "@/lib/application-data";
import { connectorDraftJob } from "@/lib/connector/draft";
import { readPastedPosting } from "@/lib/connector/handoff";
import { saveWrittenApplication, WRITTEN_IN_CLAUDE, writtenDetailsSchema, writtenLetterSchema, writtenMatchSchema, writtenResumeSchema } from "@/lib/connector/write";
import { fitBand } from "@/lib/fit";
import { matchLead, MATCH_VERSION } from "@/lib/leads/match";
import { startLeadsRefresh } from "@/lib/leads/refresh";
import { getLead, listLeads, upsertLeads, updateLead } from "@/lib/leads/store";
import { domainOf, emailLabel } from "@/lib/leads/text";
import { LEAD_PLACES, LEAD_SOURCES, LEAD_STATUSES, leadFilterSchema, type LeadView } from "@/lib/leads/types";
import { countryCodeFor, countryName } from "@/lib/job-search/countries";
import { fullText } from "@/lib/job-search/find";
import { foundPostingSchema, POSTED_WITHIN, postingText, type FoundPosting, type PostedWithin, type SearchQuery, type ShownPosting } from "@/lib/job-search/search";
import { getJob, startJob } from "@/lib/jobs/runner";
import { fetchPosting } from "@/lib/posting-fetch";
import { loadSearch, runSearch, showMoreFor } from "@/lib/posting-searches";
import { foundFromPosting, storePosting } from "@/lib/postings";
import { saveScore } from "@/lib/posting-scores";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { statusInfo } from "@/lib/status";
import { applyStatusChange } from "@/lib/status-changes";
import { appVersion } from "@/lib/version";

// The Claude connector's tools (src/app/api/mcp): search for jobs, read the
// profile and applications, draft applications and move them along. Like
// the AI features, they never send anything: no application, no email.
// Private notes and contact details stay out of what Claude is given.

type Content = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (value: unknown): Content => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (message: string): Content => ({ content: [{ type: "text", text: message }], isError: true });

const POSTED = POSTED_WITHIN.map((option) => option.value) as [PostedWithin, ...PostedWithin[]];

/** A posting as Claude sees it in a list: numbered, without its whole text. */
function postingLine(posting: ShownPosting | FoundPosting, number: number) {
  const state = "state" in posting ? posting.state : null;
  return {
    number,
    title: posting.title,
    company: posting.company,
    place: posting.place,
    remote: posting.remote,
    salary: posting.salary || undefined,
    posted: posting.postedAt?.slice(0, 10),
    via: posting.via || undefined,
    url: posting.url || undefined,
    saved: state?.saved || undefined,
    applied: state?.applicationId ? true : undefined,
    fit: state?.score ? state.score : undefined,
    snippet: posting.description.replace(/\s+/g, " ").slice(0, 280),
  };
}

/** The text of a tailored document's parts, in order. */
function documentText(units: unknown): string {
  const parsed = unitsSchema.safeParse(units);
  if (!parsed.success) return "";
  return parsed.data.map((unit) => `## ${unit.label || unit.id}\n${unit.text}`).join("\n\n");
}

/** Where a posting comes from, in a tool's input. */
const postingSource = {
  posting_id: z.string().optional().describe("A posting Dossier handed over, by its posting_id"),
  paste_id: z.string().optional().describe("A pasted posting Dossier handed over, by its paste_id"),
  search_id: z.string().optional().describe("A search from search_jobs"),
  number: z.number().int().min(1).optional().describe("The posting's number in that search"),
  posting_url: z.url().optional().describe("The posting's web address"),
  posting_text: z.string().max(100_000).optional().describe("The posting's text, pasted"),
};

type PostingSource = { posting_id?: string; paste_id?: string; search_id?: string; number?: number; posting_url?: string; posting_text?: string };
type ResolvedPosting = { text: string; url: string; postingId: string | null; title?: string; company?: string; place?: string };

/** The whole text of a posting from a search, a link or pasted text, or what's wrong. */
async function resolvePosting(source: PostingSource): Promise<ResolvedPosting | { error: string }> {
  if (source.posting_id) {
    const row = await prisma.posting.findUnique({ where: { id: source.posting_id } });
    if (!row) return { error: "That posting is no longer in Dossier. Open it again from Find jobs." };
    const found = foundFromPosting(row);
    const description = found.complete ? found.description : ((await fullText(found)) ?? found.description);
    if (!description.trim()) return { error: "That posting has no text to write from. Give its link as posting_url instead." };
    return { text: postingText({ ...found, description }), url: found.url, postingId: row.id, title: found.title, company: found.company, place: found.place };
  }
  if (source.paste_id) {
    const pasted = await readPastedPosting(source.paste_id);
    if (!pasted) return { error: "That pasted posting is no longer kept. Paste it into New application again, or here as posting_text." };
    return { text: pasted.text, url: pasted.url, postingId: null };
  }
  if (source.search_id) {
    const search = await prisma.postingSearch.findUnique({ where: { id: source.search_id }, select: { postings: true } });
    const kept = foundPostingSchema.array().catch([]).parse(search?.postings ?? []);
    const found = source.number ? kept[source.number - 1] : undefined;
    if (!found) return { error: "There's no such posting in that search. Use a number from search_jobs." };
    const description = (await fullText(found)) ?? found.description;
    if (!description.trim()) return { error: "That posting has no text to write from. Give its link as posting_url instead." };
    return {
      text: postingText({ ...found, description }),
      url: found.url,
      postingId: (await storePosting(found)).id,
      title: found.title,
      company: found.company,
      place: found.place,
    };
  }
  if (source.posting_url) {
    const fetched = await fetchPosting(source.posting_url);
    if (!fetched.ok) return { error: `${fetched.error} Paste the posting's text as posting_text instead.` };
    return { text: fetched.text, url: fetched.url, postingId: null };
  }
  if (source.posting_text?.trim()) return { text: source.posting_text.trim(), url: "", postingId: null };
  return { error: "Give search_id and number, posting_url, or posting_text." };
}

/** A startup as Claude sees it in a list. */
function leadLine(lead: LeadView) {
  return {
    lead_id: lead.id,
    company: lead.company,
    score: lead.score,
    why: lead.reasons,
    summary: lead.summary,
    found_on: lead.source,
    location: lead.location || undefined,
    remote: lead.remote ?? undefined,
    stage: lead.stage || undefined,
    roles: lead.roles.length ? lead.roles : undefined,
    posted: lead.postedAt?.slice(0, 10),
    website: lead.website || undefined,
    emails: lead.emails.map((entry) => ({ email: entry.email, kind: entry.label, published_at: entry.from || undefined })),
    links: lead.links,
    status: lead.status,
  };
}

/** The address of a page in Dossier, for links in answers. */
const linkTo = (origin: string, path: string) => `${origin}${path}`;

export function createDossierServer(origin: string): McpServer {
  const server = new McpServer(
    { name: "dossier", title: "Dossier", version: appVersion },
    {
      instructions:
        "Dossier is the user's own job search app: one profile, tailored resumes and cover letters, and every application tracked. " +
        "Search jobs with search_jobs (the user looks in Bangalore plus remote jobs in India unless they say otherwise). " +
        "For startups to write to directly (hiring on YC or Hacker News, or just funded), use find_startups; write the user a short cold email from facts in the profile, and record it with update_startup once they've sent it. " +
        "and when the user wants to know which fit best, score them against the profile and save the scores with save_job_scores. " +
        "To draft an application, you write it yourself: call get_profile and get_posting, write a tailored resume and cover letter " +
        "from facts in the profile only (never invent experience, employers, numbers or degrees; say what's missing instead), " +
        "show the user a short summary, then save it with save_application. Read or update applications with the other tools. " +
        "Nothing is ever sent for the user: drafts wait in Dossier for them to review and download as PDFs.",
    },
  );

  server.registerTool(
    "get_profile",
    {
      title: "Read the profile",
      description:
        "The user's profile in Dossier: headline, summary, skills, languages, experience, projects and education, with the ids save_application uses. Contact details are left out.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const profile = await loadProfile();
      const skills = new Map(profile.skills.map((skill) => [skill.id, skill.name]));
      const span = (item: { startYear: number | null; startMonth: number | null; endYear: number | null; endMonth: number | null; current: boolean }) =>
        [item.startYear ? `${item.startYear}${item.startMonth ? `-${String(item.startMonth).padStart(2, "0")}` : ""}` : "", item.current ? "now" : item.endYear ? `${item.endYear}${item.endMonth ? `-${String(item.endMonth).padStart(2, "0")}` : ""}` : ""]
          .filter(Boolean)
          .join(" to ");
      return text({
        name: profile.basics.name,
        headline: profile.basics.headline,
        city: profile.basics.city,
        country: profile.basics.country,
        summary: profile.basics.summary,
        skills: profile.skills.map((skill) => skill.name),
        languages: profile.languages.map((language) => `${language.name} (${language.level})`),
        experience: profile.experience.map((role) => ({ id: role.id, role: role.role, company: role.company, location: role.location, when: span(role), bullets: role.bullets, skills: role.skillIds.map((id) => skills.get(id)).filter(Boolean) })),
        projects: profile.projects.map((project) => ({ id: project.id, name: project.name, link: project.link, when: span(project), bullets: project.bullets })),
        education: profile.education.map((entry) => ({ id: entry.id, degree: entry.degree, school: entry.school, when: span(entry), notes: entry.notes })),
        link: linkTo(origin, "/profile"),
      });
    },
  );

  server.registerTool(
    "search_jobs",
    {
      title: "Search for jobs",
      description:
        "Searches the job source set up in Dossier (JSearch, Adzuna or the Arbeitsagentur) and keeps the search in Find jobs → Past searches. " +
        "With a place and plus_remote, it also finds remote postings across the country. Each search uses one or two searches from the user's plan. " +
        "Returns a search_id and numbered postings; pass both to draft_application, or the search_id to more_jobs.",
      inputSchema: {
        keywords: z.string().min(1).max(200).describe("Job title, skill or company, e.g. 'android developer'"),
        place: z.string().max(200).optional().describe("City or region. Defaults to the profile's city (e.g. Bangalore). Use '' for the whole country."),
        country: z.string().max(60).optional().describe("Country name or ISO code, e.g. 'India' or 'in'. Defaults to the profile's country."),
        plus_remote: z.boolean().optional().describe("Also include remote postings across the country. Defaults to true when there's a place."),
        remote_only: z.boolean().optional().describe("Only remote postings."),
        radius_km: z.union([z.literal(10), z.literal(25), z.literal(50), z.literal(100), z.literal(200)]).optional(),
        posted_within: z.enum(POSTED).optional().describe("any, day, 3days, week or month. Defaults to month."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (input) => {
      const profile = await loadProfile();
      const place = (input.place ?? profile.basics.city).trim();
      const country = countryCodeFor(input.country ?? profile.basics.country) || (input.country?.trim().length === 2 ? input.country.trim().toLowerCase() : "");
      if (!country) return failure("Say which country to search in, e.g. country: 'India'.");
      const remoteOnly = input.remote_only ?? false;
      const query: SearchQuery = {
        keywords: input.keywords.trim(),
        place: remoteOnly ? "" : place,
        country,
        radiusKm: input.radius_km ?? 25,
        remoteOnly,
        postedWithin: input.posted_within ?? "month",
        ...(!remoteOnly && place && (input.plus_remote ?? true) ? { alsoRemote: true } : {}),
      };
      const ran = await runSearch(query);
      if (!ran.ok) return failure(ran.message);
      const search = await loadSearch(ran.id);
      if (!search) return failure("The search ran, but couldn't be read back. Try again.");
      return text({
        search_id: search.id,
        searched: `${query.keywords} in ${query.place || countryName(country)}${query.alsoRemote ? " plus remote" : ""}${query.remoteOnly ? " (remote only)" : ""}`,
        found: search.postings.length,
        more_available: search.next !== null,
        postings: search.postings.map((posting, index) => postingLine(posting, index + 1)),
        link: linkTo(origin, `/jobs?search=${search.id}`),
      });
    },
  );

  server.registerTool(
    "more_jobs",
    {
      title: "Show more jobs",
      description: "The next page of a search from search_jobs. Uses one or two more searches from the user's plan.",
      inputSchema: { search_id: z.string().min(1) },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ search_id }) => {
      const before = await prisma.postingSearch.findUnique({ where: { id: search_id }, select: { found: true } });
      if (!before) return failure("That search is no longer kept. Search again.");
      const more = await showMoreFor(search_id);
      if (!more.ok) return failure(more.message);
      return text({
        search_id,
        added: more.postings.length,
        more_available: more.next !== null,
        postings: more.postings.map((posting, index) => postingLine(posting, before.found + index + 1)),
      });
    },
  );

  server.registerTool(
    "save_job_scores",
    {
      title: "Save fit scores for postings",
      description:
        "Saves how well postings fit the user (from a search_jobs search by number, or handed over by posting_id), so Find jobs shows each score with its reasons. " +
        "Read the profile first, and the whole posting with get_posting when the snippet is too short to judge. " +
        "Score each from 0 to 100 against the profile from get_profile: 85-100 excellent (clearly meets the core requirements), 70-84 good (most core requirements, a gap or two), 50-69 possible (meaningful gaps or a stretch), 0-49 poor. Judge skills and experience, seniority and scope, location, remote work and language, and salary when both say something. Give one to four short reasons, each tying a requirement to a specific role, project, skill or degree, and up to three real red flags. Never invent experience, and never use age, gender, nationality or any other protected characteristic.",
      inputSchema: {
        search_id: z.string().optional().describe("The search the numbered postings are from"),
        scores: z
          .array(
            z.object({
              number: z.number().int().min(1).optional().describe("The posting's number in the search"),
              posting_id: z.string().optional().describe("Instead of a number: a posting Dossier handed over"),
              score: z.number().int().min(0).max(100),
              reasons: z.array(z.string().max(300)).min(1).max(4),
              red_flags: z.array(z.string().max(300)).max(3).default([]),
            }),
          )
          .min(1)
          .max(50),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ search_id, scores }) => {
      const search = search_id ? await prisma.postingSearch.findUnique({ where: { id: search_id }, select: { postings: true } }) : null;
      if (search_id && !search) return failure("That search is no longer kept. Search again.");
      const kept = foundPostingSchema.array().catch([]).parse(search?.postings ?? []);
      const saved: { number?: number; posting_id?: string; title: string; score: number; band: string }[] = [];
      const missing: (number | string)[] = [];
      for (const entry of scores) {
        const row = entry.posting_id ? await prisma.posting.findUnique({ where: { id: entry.posting_id } }) : null;
        const posting = row ? foundFromPosting(row) : entry.number ? kept[entry.number - 1] : undefined;
        if (!posting) {
          missing.push(entry.posting_id ?? entry.number ?? "?");
          continue;
        }
        const fit = scoreFrom({ score: entry.score, reasons: entry.reasons, redFlags: entry.red_flags });
        await saveScore(posting, fit, WRITTEN_IN_CLAUDE);
        saved.push({ number: entry.number, posting_id: entry.posting_id, title: posting.title, score: fit.score, band: fitBand(fit.score) });
      }
      return text({ saved, not_found: missing.length > 0 ? missing : undefined, link: linkTo(origin, search_id ? `/jobs?search=${search_id}` : "/jobs?view=saved") });
    },
  );

  server.registerTool(
    "find_startups",
    {
      title: "Find startups to write to",
      description:
        "Startups the user could write to, from Dossier's Startups list: hiring on Y Combinator or Hacker News 'Who is hiring', or just funded (Inc42, TechCrunch), " +
        "ranked against the profile, with the email addresses they publish. Filter by words, place, source, minimum match, and whether they have an email.",
      inputSchema: {
        query: z.string().max(200).optional().describe("Words to look for, e.g. 'android' or 'fintech'"),
        place: z.enum(LEAD_PLACES).optional().describe("any, city (the profile's city, e.g. Bengaluru), india or remote"),
        source: z.enum(LEAD_SOURCES).optional(),
        min_score: z.number().int().min(0).max(100).optional(),
        with_email: z.boolean().optional().describe("Only ones with an address to write to"),
        status: z.enum(LEAD_STATUSES).optional().describe("NEW (default), SAVED, CONTACTED or DISMISSED"),
        sort: z.enum(["match", "newest"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const profile = await loadProfile();
      const filter = leadFilterSchema.parse({
        q: input.query ?? "",
        place: input.place,
        source: input.source ?? "",
        minScore: input.min_score,
        withEmail: input.with_email ?? false,
        status: input.status,
        sort: input.sort,
      });
      const list = await listLeads(filter, { limit: input.limit ?? 20, city: profile.basics.city });
      return text({
        total: list.total,
        startups: list.leads.map((lead) => leadLine(lead)),
        note: list.total === 0 && Object.values(list.counts).every((count) => count === 0) ? "The list is empty: call refresh_startups first." : undefined,
        link: linkTo(origin, "/startups"),
      });
    },
  );

  server.registerTool(
    "get_startup",
    {
      title: "Read a startup",
      description: "One startup from find_startups with everything Dossier knows: what it does, the hiring post or news, roles, emails it publishes, links and notes.",
      inputSchema: { lead_id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ lead_id }) => {
      const lead = await getLead(lead_id);
      if (!lead) return failure("There's no such startup in Dossier.");
      return text({ ...leadLine(lead), details: lead.details.slice(0, 12_000), notes: lead.notes || undefined });
    },
  );

  server.registerTool(
    "update_startup",
    {
      title: "Update a startup",
      description:
        "Records what happened with a startup: its status (SAVED, CONTACTED once the user has written, DISMISSED), notes, its website, " +
        "email addresses the company publishes that you found (with where), or your own fit score with reasons. Never add guessed addresses.",
      inputSchema: {
        lead_id: z.string().min(1),
        status: z.enum(LEAD_STATUSES).optional(),
        notes: z.string().max(5_000).optional(),
        website: z.url().optional(),
        emails: z.array(z.object({ email: z.email(), found_at: z.url().describe("The page that publishes it") })).max(10).optional(),
        score: z.number().int().min(0).max(100).optional(),
        reasons: z.array(z.string().max(300)).max(4).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ lead_id, status, notes, website, emails, score, reasons }) => {
      const lead = await updateLead(lead_id, {
        status,
        notes,
        website,
        emails: emails?.map((entry) => ({ email: entry.email.toLowerCase(), label: emailLabel(entry.email), from: entry.found_at })),
        score: score !== undefined ? { score, reasons: reasons?.length ? reasons : ["Scored by Claude."] } : undefined,
      });
      if (!lead) return failure("There's no such startup in Dossier.");
      return text(leadLine(lead));
    },
  );

  server.registerTool(
    "add_startup",
    {
      title: "Add a startup",
      description:
        "Adds a startup the user found elsewhere (a Wellfound, Crunchbase, LinkedIn or company page they named) to Dossier's Startups list, scored against the profile. " +
        "Only add what you looked up for the user, one company at a time, and only email addresses the company publishes.",
      inputSchema: {
        company: z.string().min(1).max(200),
        website: z.url().optional(),
        summary: z.string().max(1_000).describe("What it does, in a sentence"),
        details: z.string().max(10_000).optional().describe("More: what it's building, its round, roles it's hiring for"),
        location: z.string().max(300).optional(),
        remote: z.boolean().optional(),
        stage: z.string().max(200).optional().describe("e.g. Seed, Series A, raised $5M"),
        roles: z.array(z.string().max(160)).max(8).optional(),
        tags: z.array(z.string().max(60)).max(10).optional(),
        emails: z.array(z.object({ email: z.email(), found_at: z.url() })).max(10).optional(),
        links: z.array(z.object({ label: z.string().max(60), url: z.url() })).max(6).optional().describe("e.g. its Wellfound or Crunchbase page, careers page"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (input) => {
      const externalId = domainOf(input.website ?? "") || input.company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (!externalId) return failure("Give the company's name or website.");
      const found = {
        source: "CLAUDE" as const,
        externalId,
        company: input.company.trim(),
        website: input.website ?? "",
        summary: input.summary.trim(),
        details: input.details?.trim() ?? "",
        location: input.location?.trim() ?? "",
        remote: input.remote ?? null,
        stage: input.stage?.trim() ?? "",
        teamSize: null,
        tags: input.tags ?? [],
        roles: input.roles ?? [],
        emails: (input.emails ?? []).map((entry) => ({ email: entry.email.toLowerCase(), label: emailLabel(entry.email), from: entry.found_at })),
        links: [...(input.website ? [{ label: "Website", url: input.website }] : []), ...(input.links ?? [])],
        postedAt: new Date().toISOString(),
      };
      await upsertLeads([found]);
      const list = await listLeads(leadFilterSchema.parse({ q: found.company, source: "CLAUDE" }), { limit: 1 });
      const lead = list.leads[0];
      const fit = matchLead(found, await loadProfile());
      return text({ added: true, lead_id: lead?.id, score: lead?.score ?? fit.score, reasons: lead?.reasons ?? fit.reasons, scored_with: MATCH_VERSION, link: linkTo(origin, "/startups?source=CLAUDE") });
    },
  );

  server.registerTool(
    "refresh_startups",
    {
      title: "Refresh the startups list",
      description: "Asks Y Combinator, Hacker News, Inc42 and TechCrunch for new startups now, in the background (a minute or two); it also runs once a day on its own. Call find_startups afterwards.",
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async () => {
      await startLeadsRefresh();
      return text({ status: "started", next: "Wait a minute or two, then call find_startups." });
    },
  );

  server.registerTool(
    "list_applications",
    {
      title: "List applications",
      description: "The user's applications in Dossier, newest activity first, with their status. Optionally only one status.",
      inputSchema: {
        status: z.enum(ApplicationStatus).optional().describe("DRAFT, SENT, SCREENING, INTERVIEW, OFFER, ACCEPTED, REJECTED or DECLINED"),
        include_archived: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status, include_archived, limit }) => {
      const rows = await prisma.application.findMany({
        where: { awaitingReview: false, ...(status ? { status } : {}), ...(include_archived ? {} : { archivedAt: null }) },
        orderBy: { updatedAt: "desc" },
        take: limit ?? 30,
        select: { id: true, title: true, company: true, role: true, location: true, status: true, updatedAt: true, postingUrl: true },
      });
      return text(
        rows.map((row) => ({
          id: row.id,
          title: row.title,
          company: row.company,
          role: row.role,
          location: row.location,
          status: statusInfo(row.status).label,
          updated: row.updatedAt.toISOString().slice(0, 10),
          posting: row.postingUrl || undefined,
          link: linkTo(origin, `/applications/${row.id}`),
        })),
      );
    },
  );

  server.registerTool(
    "get_application",
    {
      title: "Read an application",
      description: "One application with its posting, how the profile matches it, and the tailored resume and cover letter as text. Private notes are left out.",
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const application = await prisma.application.findUnique({
        where: { id },
        select: {
          id: true, title: true, company: true, role: true, location: true, mode: true, salary: true, status: true, postingUrl: true, postingText: true, match: true,
          documents: { select: { kind: true, units: true } },
        },
      });
      if (!application) return failure("That application no longer exists.");
      const doc = (kind: DocumentKind) => documentText(application.documents.find((document) => document.kind === kind)?.units);
      return text({
        id: application.id,
        title: application.title,
        company: application.company,
        role: application.role,
        location: application.location,
        mode: application.mode,
        salary: application.salary,
        status: statusInfo(application.status).label,
        posting_url: application.postingUrl || undefined,
        posting: application.postingText.slice(0, 20_000),
        match: application.match,
        resume: doc(DocumentKind.RESUME),
        cover_letter: doc(DocumentKind.COVER_LETTER),
        link: linkTo(origin, `/applications/${application.id}`),
      });
    },
  );

  server.registerTool(
    "get_posting",
    {
      title: "Read a posting",
      description: "The whole text of a job posting, from a search (search_id and number), one Dossier handed over (posting_id or paste_id) or a link (posting_url), to write an application from or score.",
      inputSchema: {
        posting_id: postingSource.posting_id,
        paste_id: postingSource.paste_id,
        search_id: postingSource.search_id,
        number: postingSource.number,
        posting_url: postingSource.posting_url,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const posting = await resolvePosting(input);
      if ("error" in posting) return failure(posting.error);
      return text({ url: posting.url || undefined, title: posting.title, company: posting.company, place: posting.place, text: posting.text });
    },
  );

  server.registerTool(
    "save_application",
    {
      title: "Save an application you wrote",
      description:
        "Saves a tailored resume and cover letter you wrote as a Draft application in Dossier, where the user can review, edit and download them as PDFs. " +
        "Give the posting (posting_id or paste_id when Dossier handed it over, search_id and number, posting_url or posting_text), its details, the resume (by the ids from get_profile) and the letter. " +
        "Only use facts from the profile. Nothing is sent.",
      inputSchema: {
        ...postingSource,
        details: writtenDetailsSchema,
        resume: writtenResumeSchema,
        cover_letter: writtenLetterSchema,
        match: writtenMatchSchema.describe("What the posting asks for and whether the profile covers it, partly covers it, or has a gap; Dossier shows it as the application's match"),
        note: z.string().max(2000).optional().describe("What the user asked to stress, kept with the application"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ posting_id, paste_id, search_id, number, posting_url, posting_text, details, resume, cover_letter, match, note }) => {
      const posting = await resolvePosting({ posting_id, paste_id, search_id, number, posting_url, posting_text });
      if ("error" in posting) return failure(posting.error);
      const saved = await saveWrittenApplication({
        posting: posting.text.slice(0, 100_000),
        postingUrl: posting.url.slice(0, 2000),
        postingId: posting.postingId,
        details,
        resume,
        letter: cover_letter,
        match,
        note: note ?? "",
      });
      return text({
        application_id: saved.applicationId,
        status: "Draft",
        link: linkTo(origin, `/applications/${saved.applicationId}`),
        check_these: saved.unverified.length > 0 ? saved.unverified : undefined,
        next: saved.unverified.length > 0 ? "Dossier marked names or numbers it couldn't find in the profile or posting; tell the user to check them." : undefined,
      });
    },
  );

  server.registerTool(
    "draft_application",
    {
      title: "Have Dossier draft an application",
      description:
        "Has Dossier's own AI model draft the application, only when an AI provider is set up in Dossier's settings. " +
        "Without one, write it yourself with get_profile, get_posting and save_application. Takes one to three minutes: follow it with check_draft.",
      inputSchema: { ...postingSource, note: z.string().max(2000).optional().describe("Anything the documents should stress, in the user's words") },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ posting_id, paste_id, search_id, number, posting_url, posting_text, note }) => {
      if (!(await isAiUsable())) {
        return failure("Dossier has no AI model of its own set up. Write the application yourself: get_profile, get_posting, then save_application.");
      }
      const posting = await resolvePosting({ posting_id, paste_id, search_id, number, posting_url, posting_text });
      if ("error" in posting) return failure(posting.error);
      const jobId = await startJob(connectorDraftJob, { posting: posting.text.slice(0, 100_000), postingUrl: posting.url.slice(0, 2000), note: note ?? "", postingId: posting.postingId });
      return text({ draft_id: jobId, status: "started", next: "Call check_draft with this draft_id in a minute or so." });
    },
  );

  server.registerTool(
    "check_draft",
    {
      title: "Check a draft",
      description: "How a draft from draft_application is coming along; once done, the new application's id and link.",
      inputSchema: { draft_id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ draft_id }) => {
      const job = await getJob(draft_id);
      if (!job || job.type !== connectorDraftJob.type) return failure("There's no such draft.");
      if (job.status === "FAILED") return failure(job.error ?? "The draft couldn't be written.");
      if (job.status !== "DONE") return text({ draft_id, status: "working", step: job.step ?? "Starting", next: "Check again in a little while." });
      const result = connectorDraftJob.result.safeParse(job.result);
      if (!result.success) return failure("The draft finished, but its application couldn't be found.");
      return text({ draft_id, status: "done", application_id: result.data.applicationId, link: linkTo(origin, `/applications/${result.data.applicationId}`) });
    },
  );

  server.registerTool(
    "set_application_status",
    {
      title: "Move an application",
      description: "Changes an application's status, e.g. to SENT once the user has applied, or INTERVIEW. It only records the change; nothing is sent.",
      inputSchema: { id: z.string().min(1), status: z.enum(ApplicationStatus) },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ id, status }) => {
      if (status !== ApplicationStatus.DRAFT) {
        const pending = await prisma.agentCandidate.findFirst({ where: { applicationId: id, application: { awaitingReview: true } }, select: { id: true } });
        if (pending) await approveCandidate(pending.id);
      }
      const result = await applyStatusChange(prisma, id, status);
      if (result.outcome === "not-found") return failure("That application no longer exists.");
      return text({ id, status: statusInfo(status).label, changed: result.outcome !== "unchanged" });
    },
  );

  return server;
}
