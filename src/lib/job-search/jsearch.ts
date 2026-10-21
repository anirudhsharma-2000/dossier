import "server-only";

import { z } from "zod";

import type { JobSourceAdapter, JSearchHost, RequestContext, SourceCredentials } from "./adapter";
import { countryName } from "./countries";
import { JobSearchError, jobSearchError } from "./errors";
import { requestJson } from "./http";
import { safeLink, type FoundPosting, type PostedWithin, type SearchPage, type SearchQuery } from "./search";

// JSearch (E14-1): Google for Jobs through OpenWeb Ninja, or the same API on
// RapidAPI. One search page is one request from the plan (200 a month free).
// OpenWeb Ninja's search-v2 nests the jobs under `data` and pages with a
// cursor; the RapidAPI endpoint returns a list and pages by number. Both are
// read here.

const HOSTS: Record<JSearchHost, { base: string; path: string; headers: (key: string) => Record<string, string> }> = {
  openwebninja: {
    base: "https://api.openwebninja.com/jsearch",
    path: "/search-v2",
    headers: (key) => ({ "x-api-key": key }),
  },
  rapidapi: {
    base: "https://jsearch.p.rapidapi.com",
    path: "/search",
    headers: (key) => ({ "x-rapidapi-key": key, "x-rapidapi-host": "jsearch.p.rapidapi.com" }),
  },
};

const DATE_POSTED: Record<PostedWithin, string> = { any: "all", day: "today", "3days": "3days", week: "week", month: "month" };

/** RapidAPI's pages hold ten jobs; a full page means there may be more. */
const PAGE_SIZE = 10;

// Every field may be missing or null; one odd field doesn't drop the posting.
const maybeText = z.string().nullish().catch(null);
const maybeNumber = z.number().nullish().catch(null);
const maybeFlag = z.boolean().nullish().catch(null);

const jobSchema = z.object({
  job_id: z.string().min(1),
  job_title: maybeText,
  employer_name: maybeText,
  job_publisher: maybeText,
  job_apply_link: maybeText,
  apply_options: z
    .array(z.object({ publisher: maybeText, apply_link: maybeText, is_direct: maybeFlag }))
    .nullish()
    .catch(null),
  job_google_link: maybeText,
  job_description: maybeText,
  job_is_remote: maybeFlag,
  job_posted_at_datetime_utc: maybeText,
  job_posted_at_timestamp: maybeNumber,
  job_location: maybeText,
  job_city: maybeText,
  job_state: maybeText,
  job_country: maybeText,
  job_salary: maybeText,
  job_salary_string: maybeText,
  job_min_salary: maybeNumber,
  job_max_salary: maybeNumber,
  job_salary_currency: maybeText,
  job_salary_period: maybeText,
});
type Job = z.output<typeof jobSchema>;

/** JSearch can take well over ten seconds, especially outside the US. */
const JSEARCH_TIMEOUT_MS = 45_000;

const cursorSchema = z.string().nullish().catch(null).transform((cursor) => cursor ?? null);
const listSchema = z.array(z.unknown());

/**
 * The jobs in an answer and where the next page starts. Both hosts have
 * answered in more than one shape over time: the jobs as `data`, as
 * `data.jobs` or `data.data`, or as `jobs`, with the cursor next to them.
 * Null when the answer holds no list of jobs at all.
 */
export function jobsOf(answer: unknown): { raw: unknown[]; cursor: string | null; paged: "cursor" | "page" } | null {
  if (!answer || typeof answer !== "object") return null;
  const body = answer as Record<string, unknown>;
  const data = body.data;
  if (listSchema.safeParse(data).success) {
    const cursor = cursorSchema.parse(body.cursor);
    return { raw: data as unknown[], cursor, paged: cursor ? "cursor" : "page" };
  }
  if (data && typeof data === "object") {
    const nested = data as Record<string, unknown>;
    const list = listSchema.safeParse(nested.jobs).success ? nested.jobs : listSchema.safeParse(nested.data).success ? nested.data : null;
    if (list) return { raw: list as unknown[], cursor: cursorSchema.parse(nested.cursor ?? body.cursor), paged: "cursor" };
  }
  if (listSchema.safeParse(body.jobs).success) return { raw: body.jobs as unknown[], cursor: cursorSchema.parse(body.cursor), paged: "cursor" };
  return null;
}

/** For the log: the shape of an answer Dossier couldn't read, never its content. */
function shapeOf(answer: unknown): string {
  if (!answer || typeof answer !== "object") return typeof answer;
  const body = answer as Record<string, unknown>;
  const keys = Object.keys(body).slice(0, 12).join(", ");
  const said = typeof body.message === "string" ? body.message : (body.error as { message?: unknown } | undefined)?.message;
  return `keys: ${keys}${typeof said === "string" ? `; message: ${said.slice(0, 160)}` : ""}`;
}

const PERIODS: Record<string, string> = { YEAR: "a year", MONTH: "a month", WEEK: "a week", DAY: "a day", HOUR: "an hour" };

/** "EUR 60,000–75,000 a year", from the salary fields; empty when there's none. */
function salaryOf(job: Job): string {
  const written = job.job_salary?.trim() || job.job_salary_string?.trim();
  if (written) return written;
  const { job_min_salary: min, job_max_salary: max } = job;
  if (min == null && max == null) return "";
  const amount = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const range = min != null && max != null && min !== max ? `${amount(min)}–${amount(max)}` : amount((min ?? max)!);
  return [job.job_salary_currency, range, PERIODS[job.job_salary_period?.toUpperCase() ?? ""]].filter(Boolean).join(" ");
}

function postedAtOf(job: Job): string | null {
  const parsed = job.job_posted_at_datetime_utc ? Date.parse(job.job_posted_at_datetime_utc) : NaN;
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return job.job_posted_at_timestamp ? new Date(job.job_posted_at_timestamp * 1000).toISOString() : null;
}

/** The employer's own apply link when there is one, else the publisher's. */
function linkOf(job: Job): string {
  const options = job.apply_options ?? [];
  const direct = options.find((option) => option.is_direct && safeLink(option.apply_link));
  return safeLink(direct?.apply_link) || safeLink(job.job_apply_link) || safeLink(options[0]?.apply_link) || safeLink(job.job_google_link);
}

/**
 * Where the job is. JSearch writes the location in the country's language
 * with the publisher after a bullet ("Hamburg  •  über Stepstone"), and often
 * leaves the city fields empty.
 */
function placeOf(job: Job): string {
  const written = (job.job_location ?? "").split("•")[0].replace(/\s+/g, " ").trim();
  if (written) return written;
  return [job.job_city, job.job_state, job.job_country ? countryName(job.job_country.toLowerCase()) : null].filter(Boolean).join(", ");
}

export function postingFromJob(job: Job): FoundPosting {
  const description = (job.job_description ?? "").trim().slice(0, 100_000);
  return {
    source: "JSEARCH",
    externalId: job.job_id.slice(0, 500),
    title: (job.job_title ?? "").trim().slice(0, 500),
    company: (job.employer_name ?? "").trim().slice(0, 300),
    place: placeOf(job).slice(0, 300),
    remote: job.job_is_remote ?? null,
    salary: salaryOf(job).slice(0, 200),
    postedAt: postedAtOf(job),
    url: linkOf(job).slice(0, 2000),
    via: (job.job_publisher ?? "").trim().slice(0, 100),
    description,
    complete: description.length > 0,
  };
}

/** "designer in Hamburg": JSearch reads the place from the query text, as Google does. */
function queryText({ keywords, place }: SearchQuery): string {
  return place ? `${keywords} in ${place}` : keywords;
}

function searchUrl(query: SearchQuery, host: JSearchHost, next: string | null, baseUrl?: string, path = HOSTS[host].path): URL {
  const { base } = HOSTS[host];
  const url = new URL(`${baseUrl ?? base}${path}`);
  url.searchParams.set("query", queryText(query));
  // Without a country, JSearch searches the US.
  url.searchParams.set("country", query.country || "us");
  url.searchParams.set("date_posted", DATE_POSTED[query.postedWithin]);
  if (query.place) url.searchParams.set("radius", String(query.radiusKm));
  if (query.remoteOnly) url.searchParams.set("work_from_home", "true");
  if (next?.startsWith("cursor:")) {
    url.searchParams.set("cursor", next.slice("cursor:".length));
  } else if (path === "/search") {
    url.searchParams.set("page", next?.startsWith("page:") ? next.slice("page:".length) : "1");
    url.searchParams.set("num_pages", "1");
  }
  return url;
}

async function searchPage(
  query: SearchQuery,
  { key, host }: SourceCredentials["JSEARCH"],
  next: string | null,
  context: RequestContext = {},
): Promise<SearchPage> {
  const ask = (url: URL) => requestJson("JSEARCH", url, { headers: HOSTS[host].headers(key), signal: context.signal, timeoutMs: JSEARCH_TIMEOUT_MS });
  let url = searchUrl(query, host, next, context.baseUrl, next?.startsWith("cursor:") ? "/search-v2" : HOSTS[host].path);
  let answer: unknown;
  try {
    answer = await ask(url);
  } catch (error) {
    // RapidAPI's listing may only offer the newer search-v2 now: try that once.
    if (!(host === "rapidapi" && url.pathname.endsWith("/search") && error instanceof JobSearchError && error.problem === "changed")) throw error;
    url = searchUrl(query, host, next, context.baseUrl, "/search-v2");
    answer = await ask(url);
  }
  const found = jobsOf(answer);
  if (!found) {
    // An error answered with 200: a used-up plan says so in words.
    const shape = shapeOf(answer);
    if (/quota|limit|exceeded|upgrade/i.test(shape)) throw jobSearchError("quota", "JSEARCH", { detail: `${url.pathname}: ${shape}` });
    if (/subscri|api key|unauthori|forbidden/i.test(shape)) throw jobSearchError("key", "JSEARCH", { detail: `${url.pathname}: ${shape}` });
    throw jobSearchError("changed", "JSEARCH", { detail: `${url.pathname}: unexpected answer (${shape})` });
  }

  const { raw } = found;
  const seen = new Set<string>();
  const postings: FoundPosting[] = [];
  for (const item of raw) {
    const job = jobSchema.safeParse(item);
    if (!job.success || seen.has(job.data.job_id)) continue;
    seen.add(job.data.job_id);
    postings.push(postingFromJob(job.data));
  }

  const page = Number(url.searchParams.get("page") ?? "1");
  const nextToken = found.cursor
    ? `cursor:${found.cursor}`
    : found.paged === "page" && host === "rapidapi" && raw.length >= PAGE_SIZE
      ? `page:${page + 1}`
      : null;
  return { postings, next: nextToken };
}

export const jsearch: JobSourceAdapter<"JSEARCH"> = {
  source: "JSEARCH",
  search: searchPage,
  // Search results carry the whole description.
  details: async (posting) => (posting.description ? posting.description : null),
  test: async (credentials, context) => {
    await searchPage({ keywords: "developer", place: "", country: "us", radiusKm: 25, remoteOnly: false, postedWithin: "any" }, credentials, null, context);
  },
};
