import "server-only";

import { logServerError } from "@/lib/log";

import type { JobSourceAdapter, RequestContext, SourceCredentials } from "./adapter";
import { cached, remember } from "./cache";
import { JobSearchError, jobSearchError } from "./errors";
import { adzuna } from "./adzuna";
import { arbeitsagentur } from "./arbeitsagentur";
import { jsearch } from "./jsearch";
import { plusRemote, postingKey, type FoundPosting, type JobSource, type SearchPage, type SearchQuery } from "./search";
import { sourceCovers } from "./sources";

// Searching the chosen job source from the server (E14-1). Results are
// cached for half an hour; failures come back as JobSearchError with a
// message for the screen, and the ones that point at a problem with the
// source are logged, without the search.

export type { JSearchHost, RequestContext, SourceCredentials } from "./adapter";
export { JobSearchError } from "./errors";

const ADAPTERS: { [S in JobSource]: JobSourceAdapter<S> } = {
  JSEARCH: jsearch,
  ADZUNA: adzuna,
  ARBEITSAGENTUR: arbeitsagentur,
};

const adapterFor = <S extends JobSource>(source: S) => ADAPTERS[source] as JobSourceAdapter<S>;

/** Logs failures that say something about the source; a wrong key or a used-up quota is the user's to fix. */
async function logged<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof JobSearchError && (error.problem === "changed" || error.problem === "unavailable")) {
      logServerError("job search", new Error(error.detail ?? error.message));
    }
    throw error;
  }
}

/**
 * One page of postings for `query` from `source`, from the cache when it was
 * asked for in the last half hour. A search with a place and "Plus remote"
 * asks the source twice, for the place and for remote postings across the
 * country, and merges the two.
 */
export async function searchPostings<S extends JobSource>(
  source: S,
  credentials: SourceCredentials[S],
  query: SearchQuery,
  next: string | null = null,
  context: RequestContext = {},
): Promise<SearchPage> {
  if (!sourceCovers(source, query.country)) throw jobSearchError("country", source, { country: query.country });
  if (plusRemote(query)) return searchPlaceAndRemote(source, credentials, query, next, context);
  return searchOne(source, credentials, query, next, context);
}

// ─── Place plus remote ───────────────────────────────────────────────────────

const BOTH = "both:";
/** Where each half of a merged search goes on; null once that half has no more pages. */
type BothNext = { place: string | null; remote: string | null };

const encodeBoth = (next: BothNext) => `${BOTH}${Buffer.from(JSON.stringify(next)).toString("base64url")}`;

function decodeBoth(token: string): BothNext | null {
  if (!token.startsWith(BOTH)) return null;
  try {
    const value = JSON.parse(Buffer.from(token.slice(BOTH.length), "base64url").toString("utf8")) as Partial<BothNext>;
    const side = (item: unknown) => (typeof item === "string" ? item : null);
    return { place: side(value.place), remote: side(value.remote) };
  } catch {
    return null;
  }
}

/** Takes turns from each list, so remote postings don't all end up at the bottom. */
function interleave<T>(first: readonly T[], second: readonly T[]): T[] {
  const merged: T[] = [];
  for (let index = 0; index < Math.max(first.length, second.length); index++) {
    if (index < first.length) merged.push(first[index]);
    if (index < second.length) merged.push(second[index]);
  }
  return merged;
}

/** Marks which half of a merged search is still to be asked for its first page. */
const FIRST = "@first";

async function searchPlaceAndRemote<S extends JobSource>(
  source: S,
  credentials: SourceCredentials[S],
  query: SearchQuery,
  next: string | null,
  context: RequestContext,
): Promise<SearchPage> {
  const sides: BothNext = next ? (decodeBoth(next) ?? { place: null, remote: null }) : { place: FIRST, remote: FIRST };
  const placeQuery: SearchQuery = { ...query, alsoRemote: false, remoteOnly: false };
  const remoteQuery: SearchQuery = { ...query, alsoRemote: false, place: "", remoteOnly: true };
  const ask = (half: SearchQuery, token: string | null) =>
    token === null ? Promise.resolve<SearchPage>({ postings: [], next: null }) : searchOne(source, credentials, half, token === FIRST ? null : token, context);

  const [place, remote] = await Promise.allSettled([ask(placeQuery, sides.place), ask(remoteQuery, sides.remote)]);
  // One half failing still shows the other's postings; both failing says why.
  if (place.status === "rejected" && remote.status === "rejected") throw place.reason;
  const placePage = place.status === "fulfilled" ? place.value : { postings: [], next: null };
  const remotePage = remote.status === "fulfilled" ? remote.value : { postings: [], next: null };

  const seen = new Set<string>();
  const postings = interleave(placePage.postings, remotePage.postings).filter((posting) => {
    const key = postingKey(posting);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const after: BothNext = { place: placePage.next, remote: remotePage.next };
  return { postings, next: after.place || after.remote ? encodeBoth(after) : null };
}

/** One page for one query from the source, through the cache. */
async function searchOne<S extends JobSource>(
  source: S,
  credentials: SourceCredentials[S],
  query: SearchQuery,
  next: string | null,
  context: RequestContext,
): Promise<SearchPage> {
  const adapter = adapterFor(source);
  const key = `search:${source}:${JSON.stringify(query)}:${next ?? ""}`;
  const hit = cached<SearchPage>(key);
  if (hit) return hit;
  const page = await logged(() => adapter.search(query, credentials, next, context));
  remember(key, page);
  return page;
}

/** The whole text of a posting: its own description when that's complete, else fetched; null when it can't be had. */
export async function postingDetails<S extends JobSource>(
  source: S,
  credentials: SourceCredentials[S],
  posting: FoundPosting,
  context: RequestContext = {},
): Promise<string | null> {
  if (posting.complete) return posting.description;
  const key = `details:${postingKey(posting)}`;
  const hit = cached<string>(key);
  if (hit) return hit;
  const text = await logged(() => adapterFor(source).details(posting, credentials, context));
  if (text) remember(key, text);
  return text;
}

/** "Test connection" in Settings → Job search: throws a JobSearchError when the source or the key doesn't work. */
export async function testSource<S extends JobSource>(source: S, credentials: SourceCredentials[S], context: RequestContext = {}): Promise<void> {
  await logged(() => adapterFor(source).test(credentials, context));
}
