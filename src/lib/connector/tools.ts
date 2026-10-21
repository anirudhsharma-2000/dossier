import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ApplicationStatus, DocumentKind } from "@/generated/prisma/enums";
import { approveCandidate } from "@/lib/agent/draft";
import { loadAiConfig } from "@/lib/ai/config";
import { providerOption } from "@/lib/ai/provider-options";
import { scoreFrom } from "@/lib/ai/tasks/score-posting";
import { unitsSchema } from "@/lib/application-data";
import { connectorDraftJob } from "@/lib/connector/draft";
import { saveWrittenApplication, WRITTEN_IN_CLAUDE, writtenDetailsSchema, writtenLetterSchema, writtenMatchSchema, writtenResumeSchema } from "@/lib/connector/write";
import { fitBand } from "@/lib/fit";
import { countryCodeFor, countryName } from "@/lib/job-search/countries";
import { fullText } from "@/lib/job-search/find";
import { foundPostingSchema, POSTED_WITHIN, postingText, type FoundPosting, type PostedWithin, type SearchQuery, type ShownPosting } from "@/lib/job-search/search";
import { getJob, startJob } from "@/lib/jobs/runner";
import { fetchPosting } from "@/lib/posting-fetch";
import { loadSearch, runSearch, showMoreFor } from "@/lib/posting-searches";
import { storePosting } from "@/lib/postings";
import { saveScore } from "@/lib/posting-scores";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { isServerless } from "@/lib/serverless";
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
  search_id: z.string().optional().describe("A search from search_jobs"),
  number: z.number().int().min(1).optional().describe("The posting's number in that search"),
  posting_url: z.url().optional().describe("The posting's web address"),
  posting_text: z.string().max(100_000).optional().describe("The posting's text, pasted"),
};

type PostingSource = { search_id?: string; number?: number; posting_url?: string; posting_text?: string };
type ResolvedPosting = { text: string; url: string; postingId: string | null; title?: string; company?: string; place?: string };

/** The whole text of a posting from a search, a link or pasted text, or what's wrong. */
async function resolvePosting(source: PostingSource): Promise<ResolvedPosting | { error: string }> {
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

/** Whether Dossier has an AI model of its own that it can reach from here. */
async function dossierAiReady(): Promise<boolean> {
  try {
    const config = await loadAiConfig();
    if (providerOption(config.provider).local) return !isServerless();
    return Boolean(config.apiKey) && !config.apiKeyProblem;
  } catch {
    return false;
  }
}

/** The address of a page in Dossier, for links in answers. */
const linkTo = (origin: string, path: string) => `${origin}${path}`;

export function createDossierServer(origin: string): McpServer {
  const server = new McpServer(
    { name: "dossier", title: "Dossier", version: appVersion },
    {
      instructions:
        "Dossier is the user's own job search app: one profile, tailored resumes and cover letters, and every application tracked. " +
        "Search jobs with search_jobs (the user looks in Bangalore plus remote jobs in India unless they say otherwise), " +
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
        "Saves how well postings from a search_jobs search fit the user, so Find jobs shows each score with its reasons. " +
        "Read the profile first, and the whole posting with get_posting when the snippet is too short to judge. " +
        "Score each from 0 to 100 against the profile from get_profile: 85-100 excellent (clearly meets the core requirements), 70-84 good (most core requirements, a gap or two), 50-69 possible (meaningful gaps or a stretch), 0-49 poor. Judge skills and experience, seniority and scope, location, remote work and language, and salary when both say something. Give one to four short reasons, each tying a requirement to a specific role, project, skill or degree, and up to three real red flags. Never invent experience, and never use age, gender, nationality or any other protected characteristic.",
      inputSchema: {
        search_id: z.string().min(1),
        scores: z
          .array(
            z.object({
              number: z.number().int().min(1).describe("The posting's number in the search"),
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
      const search = await prisma.postingSearch.findUnique({ where: { id: search_id }, select: { postings: true } });
      if (!search) return failure("That search is no longer kept. Search again.");
      const kept = foundPostingSchema.array().catch([]).parse(search.postings);
      const saved: { number: number; title: string; score: number; band: string }[] = [];
      const missing: number[] = [];
      for (const entry of scores) {
        const posting = kept[entry.number - 1];
        if (!posting) {
          missing.push(entry.number);
          continue;
        }
        const fit = scoreFrom({ score: entry.score, reasons: entry.reasons, redFlags: entry.red_flags });
        await saveScore(posting, fit, WRITTEN_IN_CLAUDE);
        saved.push({ number: entry.number, title: posting.title, score: fit.score, band: fitBand(fit.score) });
      }
      return text({ saved, not_found: missing.length > 0 ? missing : undefined, link: linkTo(origin, `/jobs?search=${search_id}`) });
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
      description: "The whole text of a job posting, from a search (search_id and number), a link (posting_url) or pasted text, to write an application from.",
      inputSchema: { search_id: postingSource.search_id, number: postingSource.number, posting_url: postingSource.posting_url },
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
        "Give the posting (search_id and number, posting_url or posting_text), its details, the resume (by the ids from get_profile) and the letter. " +
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
    async ({ search_id, number, posting_url, posting_text, details, resume, cover_letter, match, note }) => {
      const posting = await resolvePosting({ search_id, number, posting_url, posting_text });
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
    async ({ search_id, number, posting_url, posting_text, note }) => {
      if (!(await dossierAiReady())) {
        return failure("Dossier has no AI model of its own set up. Write the application yourself: get_profile, get_posting, then save_application.");
      }
      const posting = await resolvePosting({ search_id, number, posting_url, posting_text });
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
