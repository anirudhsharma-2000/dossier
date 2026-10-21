import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ApplicationStatus, DocumentKind } from "@/generated/prisma/enums";
import { approveCandidate } from "@/lib/agent/draft";
import { unitsSchema } from "@/lib/application-data";
import { connectorDraftJob } from "@/lib/connector/draft";
import { countryCodeFor, countryName } from "@/lib/job-search/countries";
import { fullText } from "@/lib/job-search/find";
import { foundPostingSchema, POSTED_WITHIN, postingText, type FoundPosting, type PostedWithin, type SearchQuery, type ShownPosting } from "@/lib/job-search/search";
import { getJob, startJob } from "@/lib/jobs/runner";
import { fetchPosting } from "@/lib/posting-fetch";
import { loadSearch, runSearch, showMoreFor } from "@/lib/posting-searches";
import { storePosting } from "@/lib/postings";
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

/** The address of a page in Dossier, for links in answers. */
const linkTo = (origin: string, path: string) => `${origin}${path}`;

export function createDossierServer(origin: string): McpServer {
  const server = new McpServer(
    { name: "dossier", title: "Dossier", version: appVersion },
    {
      instructions:
        "Dossier is the user's own job search app: one profile, tailored resumes and cover letters, and every application tracked. " +
        "Search jobs with search_jobs (the user looks in Bangalore plus remote jobs in India unless they say otherwise), " +
        "draft an application with draft_application and follow it with check_draft, and read or update applications. " +
        "Nothing is ever sent for the user: drafts wait in Dossier for them to review.",
    },
  );

  server.registerTool(
    "get_profile",
    {
      title: "Read the profile",
      description: "The user's profile in Dossier: headline, summary, skills, languages, experience, projects and education. Contact details are left out.",
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
        experience: profile.experience.map((role) => ({ role: role.role, company: role.company, location: role.location, when: span(role), bullets: role.bullets, skills: role.skillIds.map((id) => skills.get(id)).filter(Boolean) })),
        projects: profile.projects.map((project) => ({ name: project.name, link: project.link, when: span(project), bullets: project.bullets })),
        education: profile.education.map((entry) => ({ degree: entry.degree, school: entry.school, when: span(entry), notes: entry.notes })),
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
    "draft_application",
    {
      title: "Draft an application",
      description:
        "Starts drafting a tailored resume and cover letter for a posting, as a Draft application in Dossier. Give exactly one of: " +
        "search_id and number (a posting from search_jobs), posting_url, or posting_text. It takes one to three minutes: " +
        "follow it with check_draft. Nothing is sent.",
      inputSchema: {
        search_id: z.string().optional(),
        number: z.number().int().min(1).optional().describe("The posting's number in that search"),
        posting_url: z.url().optional(),
        posting_text: z.string().max(100_000).optional(),
        note: z.string().max(2000).optional().describe("Anything the documents should stress, in the user's words"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ search_id, number, posting_url, posting_text, note }) => {
      let posting = "";
      let postingUrl = "";
      let postingId: string | null = null;

      if (search_id) {
        const search = await prisma.postingSearch.findUnique({ where: { id: search_id }, select: { postings: true } });
        const kept = foundPostingSchema.array().catch([]).parse(search?.postings ?? []);
        const found = number ? kept[number - 1] : undefined;
        if (!found) return failure("There's no such posting in that search. Use a number from search_jobs.");
        const description = (await fullText(found)) ?? found.description;
        if (!description.trim()) return failure("That posting has no text to write from. Give its link as posting_url instead.");
        posting = postingText({ ...found, description });
        postingUrl = found.url;
        postingId = (await storePosting(found)).id;
      } else if (posting_url) {
        const fetched = await fetchPosting(posting_url);
        if (!fetched.ok) return failure(`${fetched.error} Paste the posting's text as posting_text instead.`);
        posting = fetched.text;
        postingUrl = fetched.url;
      } else if (posting_text?.trim()) {
        posting = posting_text.trim();
      } else {
        return failure("Give search_id and number, posting_url, or posting_text.");
      }

      const jobId = await startJob(connectorDraftJob, { posting: posting.slice(0, 100_000), postingUrl: postingUrl.slice(0, 2000), note: note ?? "", postingId });
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
