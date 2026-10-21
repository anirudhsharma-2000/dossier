import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { json, stubFetch } from "@/lib/ai/test-http";
import { jsearchV1Page, jsearchV2LastPage, jsearchV2Page } from "@/test/job-search-fixtures";

import { clearJobSearchCache } from "./cache";
import { postingDetails, searchPostings, testSource } from "./index";
import { EMPTY_QUERY } from "./search";
import { sourceCovers } from "./sources";

const query = { ...EMPTY_QUERY, keywords: "designer", country: "de" };
const ninja = { key: "ak_test", host: "openwebninja" as const };

beforeEach(() => {
  clearJobSearchCache();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("searchPostings", () => {
  it("asks the source once per half hour for the same search and page", async () => {
    const requests = stubFetch(() => json(jsearchV2Page));
    const first = await searchPostings("JSEARCH", ninja, query);
    const again = await searchPostings("JSEARCH", ninja, query);
    expect(again).toEqual(first);
    expect(requests).toHaveLength(1);

    await searchPostings("JSEARCH", ninja, query, first.next);
    await searchPostings("JSEARCH", ninja, { ...query, remoteOnly: true });
    expect(requests).toHaveLength(3);
  });

  it("doesn't keep failures", async () => {
    let status = 503;
    const requests = stubFetch(() => json(jsearchV2LastPage, { status }));
    await expect(searchPostings("JSEARCH", ninja, query)).rejects.toMatchObject({ problem: "unavailable" });
    status = 200;
    await expect(searchPostings("JSEARCH", ninja, query)).resolves.toMatchObject({ next: null });
    expect(requests).toHaveLength(2);
  });

  it("logs problems with the source without the search, but not a wrong key", async () => {
    const log = vi.mocked(console.error);
    stubFetch(() => json({}, { status: 404 }));
    await expect(searchPostings("JSEARCH", ninja, query)).rejects.toMatchObject({ problem: "changed" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("[job search] Error: JSEARCH: /jsearch/search-v2: HTTP 404");
    expect(String(log.mock.calls[0][0])).not.toContain("designer");

    stubFetch(() => json({}, { status: 401 }));
    await expect(searchPostings("JSEARCH", ninja, { ...query, keywords: "other" })).rejects.toMatchObject({ problem: "key" });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("says when a source doesn't cover the country, before asking it", async () => {
    const requests = stubFetch(() => json(jsearchV2Page));
    await expect(searchPostings("ARBEITSAGENTUR", {}, { ...query, country: "fr" })).rejects.toMatchObject({
      problem: "country",
      message: "Bundesagentur für Arbeit doesn't list jobs in France. Choose another country, or another source in Settings → Job search.",
    });
    expect(requests).toHaveLength(0);
    expect(sourceCovers("ADZUNA", "de")).toBe(true);
    expect(sourceCovers("ADZUNA", "jp")).toBe(false);
    expect(sourceCovers("JSEARCH", "jp")).toBe(true);
  });
});

describe("postingDetails", () => {
  it("returns a complete description as it is", async () => {
    const requests = stubFetch(() => json(jsearchV2Page));
    const [posting] = (await searchPostings("JSEARCH", ninja, query)).postings;
    expect(await postingDetails("JSEARCH", ninja, posting)).toBe(posting.description);
    expect(requests).toHaveLength(1);
  });

  it("asks the source for the rest of an incomplete one, and keeps it", async () => {
    stubFetch(() => json(jsearchV2Page));
    const [posting] = (await searchPostings("JSEARCH", ninja, query)).postings;
    const partial = { ...posting, complete: false };
    expect(await postingDetails("JSEARCH", ninja, partial)).toBe(posting.description);
    expect(await postingDetails("JSEARCH", ninja, { ...partial, description: "" })).toBe(posting.description);
    expect(await postingDetails("JSEARCH", ninja, { ...partial, externalId: "other", description: "" })).toBeNull();
  });
});

describe("testSource", () => {
  it("passes when the source answers", async () => {
    stubFetch(() => json(jsearchV2LastPage));
    await expect(testSource("JSEARCH", ninja)).resolves.toBeUndefined();
  });

  it("throws the problem when it doesn't", async () => {
    stubFetch(() => json({}, { status: 401 }));
    await expect(testSource("JSEARCH", ninja)).rejects.toMatchObject({ problem: "key" });
  });
});

describe("searchPostings for a place plus remote", () => {
  const job = (id: string, title: string) => ({ ...jsearchV1Page.data[0], job_id: id, job_title: title });
  const bangalore = { ...EMPTY_QUERY, keywords: "android developer", place: "Bangalore", country: "in", alsoRemote: true };

  it("asks for the place and for remote jobs across the country, and takes turns from each", async () => {
    const requests = stubFetch(({ url }) =>
      url.searchParams.get("work_from_home") === "true"
        ? json({ data: { jobs: [job("r1", "Remote 1"), job("shared", "Both"), job("r2", "Remote 2")], cursor: "rc" } })
        : json({ data: { jobs: [job("b1", "Bangalore 1"), job("shared", "Both")], cursor: null } }),
    );
    const page = await searchPostings("JSEARCH", ninja, bangalore);
    const queries = requests.map(({ url }) => [url.searchParams.get("query"), url.searchParams.get("work_from_home")]);
    expect(queries).toContainEqual(["android developer in Bangalore", null]);
    expect(queries).toContainEqual(["android developer", "true"]);
    expect(page.postings.map((posting) => posting.externalId)).toEqual(["b1", "r1", "shared", "r2"]);

    // Only the remote half has more: the next page asks only it.
    expect(page.next).toMatch(/^both:/);
    requests.length = 0;
    await searchPostings("JSEARCH", ninja, bangalore, page.next);
    expect(requests).toHaveLength(1);
    expect(requests[0].url.searchParams.get("cursor")).toBe("rc");
  });

  it("still shows one half's postings when the other fails", async () => {
    stubFetch(({ url }) => (url.searchParams.get("work_from_home") === "true" ? json({}, { status: 503 }) : json({ data: { jobs: [job("b1", "Bangalore 1")], cursor: null } })));
    const page = await searchPostings("JSEARCH", ninja, bangalore);
    expect(page.postings.map((posting) => posting.externalId)).toEqual(["b1"]);
    expect(page.next).toBeNull();
  });

  it("is a plain search without a place, or with Remote only", async () => {
    const requests = stubFetch(() => json(jsearchV2LastPage));
    await searchPostings("JSEARCH", ninja, { ...bangalore, place: "" });
    await searchPostings("JSEARCH", ninja, { ...bangalore, remoteOnly: true });
    expect(requests).toHaveLength(2);
  });
});
