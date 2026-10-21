import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { json, refused, stubFetch } from "@/lib/ai/test-http";
import { jsearchKeyError, jsearchV1Page, jsearchV2LastPage, jsearchV2Page } from "@/test/job-search-fixtures";

import { JobSearchError } from "./errors";
import { jsearch } from "./jsearch";
import { EMPTY_QUERY, type SearchQuery } from "./search";

const query: SearchQuery = { ...EMPTY_QUERY, keywords: "product designer", place: "Hamburg", country: "de", radiusKm: 50, postedWithin: "week" };
const ninja = { key: "ak_test", host: "openwebninja" as const };
const rapid = { key: "rapid-test", host: "rapidapi" as const };

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("JSearch search", () => {
  it("asks OpenWeb Ninja's search-v2 with the key, place, country, radius and recency", async () => {
    const requests = stubFetch(() => json(jsearchV2Page));
    await jsearch.search(query, ninja, null);
    const [{ url, headers }] = requests;
    expect(`${url.origin}${url.pathname}`).toBe("https://api.openwebninja.com/jsearch/search-v2");
    expect(headers.get("x-api-key")).toBe("ak_test");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: "product designer in Hamburg",
      country: "de",
      date_posted: "week",
      radius: "50",
    });
  });

  it("asks RapidAPI by page, with its own headers", async () => {
    const requests = stubFetch(() => json(jsearchV1Page));
    const page = await jsearch.search({ ...query, place: "", remoteOnly: true, postedWithin: "any" }, rapid, "page:3");
    const [{ url, headers }] = requests;
    expect(`${url.origin}${url.pathname}`).toBe("https://jsearch.p.rapidapi.com/search");
    expect(headers.get("x-rapidapi-key")).toBe("rapid-test");
    expect(headers.get("x-rapidapi-host")).toBe("jsearch.p.rapidapi.com");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: "product designer",
      country: "de",
      date_posted: "all",
      work_from_home: "true",
      page: "3",
      num_pages: "1",
    });
    // A full page of ten: there may be more.
    expect(page.next).toBe("page:4");
    expect(page.postings).toHaveLength(10);
  });

  it("searches the US when no country is chosen, as JSearch would anyway", async () => {
    const requests = stubFetch(() => json(jsearchV2LastPage));
    await jsearch.search({ ...query, country: "" }, ninja, null);
    expect(requests[0].url.searchParams.get("country")).toBe("us");
  });

  it("maps postings to the shared shape, once each, preferring the employer's own link", async () => {
    stubFetch(() => json(jsearchV2Page));
    const page = await jsearch.search(query, ninja, null);
    expect(page.next).toBe("cursor:CURSOR-PAGE-2");
    expect(page.postings).toEqual([
      {
        source: "JSEARCH",
        externalId: "aG9tZWQtZGVzaWduZXItbGVkZ2VybHk=",
        title: "Senior Product Designer, Payments",
        company: "Ledgerly",
        place: "Hamburg",
        remote: false,
        salary: "EUR 75,000–90,000 a year",
        postedAt: "2026-09-30T08:00:00.000Z",
        url: "https://careers.ledgerly.example/jobs/42",
        via: "LinkedIn",
        description: expect.stringContaining("Senior Product Designer for its payments team"),
        complete: true,
      },
      {
        source: "JSEARCH",
        externalId: "bm9ydGh3aW5kLXV4LXJlc2VhcmNo",
        title: "UX Researcher",
        company: "Northwind Studio",
        place: "Berlin, Germany",
        remote: true,
        salary: "",
        postedAt: new Date(1790582400 * 1000).toISOString(),
        url: "https://de.indeed.com/viewjob?jk=abc123&from=serp",
        via: "Indeed",
        description: "Northwind Studio is looking for a UX Researcher, fully remote within Germany.",
        complete: true,
      },
    ]);
  });

  it("sends the cursor for the next page and stops when there's none", async () => {
    const requests = stubFetch(() => json(jsearchV2LastPage));
    const page = await jsearch.search(query, ninja, "cursor:CURSOR-PAGE-2");
    expect(requests[0].url.searchParams.get("cursor")).toBe("CURSOR-PAGE-2");
    expect(requests[0].url.searchParams.has("page")).toBe(false);
    expect(page.next).toBeNull();
  });

  it("stops paging RapidAPI after a short page", async () => {
    stubFetch(() => json({ data: jsearchV1Page.data.slice(0, 4) }));
    expect((await jsearch.search(query, rapid, null)).next).toBeNull();
  });

  it("goes to the fake source's address when one is given", async () => {
    const requests = stubFetch(() => json(jsearchV2LastPage));
    await jsearch.search(query, ninja, null, { baseUrl: "http://127.0.0.1:3998/jsearch" });
    expect(requests[0].url.href).toMatch(/^http:\/\/127\.0\.0\.1:3998\/jsearch\/search-v2\?/);
  });

  it("drops links that aren't web addresses, and reads salaries written as text", async () => {
    stubFetch(() =>
      json({
        data: {
          jobs: [
            {
              job_id: "x",
              job_title: "Designer",
              job_apply_link: "javascript:alert(1)",
              apply_options: [{ apply_link: "data:text/html,hi", is_direct: true }],
              job_salary: "€60K–€70K a year",
              job_min_salary: 1,
            },
            { job_id: "y", job_min_salary: 50, job_max_salary: 50, job_salary_period: "hour", job_salary_currency: "USD", job_description: "" },
            { job_id: "z", job_salary: null, job_salary_string: "40.000–50.000 € im Jahr", job_location: "Beliebiger Ort   •  über Indeed" },
          ],
          cursor: null,
        },
      }),
    );
    const [first, second, third] = (await jsearch.search(query, ninja, null)).postings;
    expect(third).toMatchObject({ salary: "40.000–50.000 € im Jahr", place: "Beliebiger Ort" });
    expect(first).toMatchObject({ url: "", salary: "€60K–€70K a year", remote: null, postedAt: null, via: "", complete: false });
    expect(second).toMatchObject({ salary: "USD 50 an hour", title: "", company: "", place: "" });
  });

  it.each([
    [401, "key"],
    [403, "key"],
    [429, "quota"],
    [503, "unavailable"],
    [404, "changed"],
  ] as const)("turns HTTP %i into a %s problem", async (status, problem) => {
    stubFetch(() => json(jsearchKeyError, { status }));
    await expect(jsearch.search(query, ninja, null)).rejects.toMatchObject({ name: "JobSearchError", problem });
  });

  it("says the source changed when the answer has an unknown shape", async () => {
    stubFetch(() => json({ data: { results: [] } }));
    const error = await jsearch.search(query, ninja, null).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobSearchError);
    expect(error).toMatchObject({ problem: "changed", detail: "JSEARCH: /jsearch/search-v2: unexpected answer (keys: data)" });
  });

  it("says the source isn't answering when it can't be reached", async () => {
    stubFetch(refused);
    await expect(jsearch.search(query, ninja, null)).rejects.toMatchObject({
      problem: "unavailable",
      message: "JSearch isn't answering right now. Try again in a minute.",
      detail: "JSEARCH: /jsearch/search-v2: ECONNREFUSED",
    });
  });
});

describe("JSearch details and test", () => {
  it("has the whole description already, so details never asks again", async () => {
    const requests = stubFetch(() => json(jsearchV2Page));
    const [posting] = (await jsearch.search(query, ninja, null)).postings;
    expect(await jsearch.details(posting, ninja)).toBe(posting.description);
    expect(await jsearch.details({ ...posting, description: "" }, ninja)).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("tests the key with one small search", async () => {
    const requests = stubFetch(() => json(jsearchV2LastPage));
    await jsearch.test(ninja);
    expect(requests).toHaveLength(1);
    expect(requests[0].url.searchParams.get("query")).toBe("developer");
  });
});

describe("JSearch answers in other shapes (Bangalore fix)", () => {
  it("reads jobs nested as data.data or at the top level, with a cursor", async () => {
    const jobs = jsearchV1Page.data.slice(0, 3);
    stubFetch(() => json({ status: "OK", data: { data: jobs, cursor: "c2" } }));
    const nested = await jsearch.search(query, ninja, null);
    expect(nested.postings).toHaveLength(3);
    expect(nested.next).toBe("cursor:c2");

    stubFetch(() => json({ jobs, cursor: null }));
    const top = await jsearch.search(query, ninja, null);
    expect(top.postings).toHaveLength(3);
    expect(top.next).toBeNull();
  });

  it("goes on with a cursor on RapidAPI too, through search-v2", async () => {
    const requests = stubFetch(() => json({ status: "OK", data: jsearchV1Page.data.slice(0, 2) }));
    await jsearch.search(query, rapid, "cursor:abc");
    expect(requests[0].url.pathname).toBe("/search-v2");
    expect(requests[0].url.searchParams.get("cursor")).toBe("abc");
    expect(requests[0].url.searchParams.has("page")).toBe(false);
  });

  it("tries search-v2 once when RapidAPI's search answers with an error", async () => {
    const requests = stubFetch(({ url }) =>
      url.pathname === "/search" ? json({ message: "Endpoint '/search' does not exist" }, { status: 404 }) : json({ status: "OK", data: { jobs: jsearchV1Page.data, cursor: "n1" } }),
    );
    const page = await jsearch.search(query, rapid, null);
    expect(requests.map((request) => request.url.pathname)).toEqual(["/search", "/search-v2"]);
    expect(page.postings).toHaveLength(10);
    expect(page.next).toBe("cursor:n1");
  });

  it("logs the API's own reason when RapidAPI refuses a search", async () => {
    stubFetch(() => json({ message: "Invalid country" }, { status: 400 }));
    const error = await jsearch.search({ ...query, country: "in" }, rapid, null).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ problem: "changed" });
    expect((error as JobSearchError).detail).toContain("(Invalid country)");
  });

  it("says the plan is used up when a 200 answer says so instead of listing jobs", async () => {
    stubFetch(() => json({ status: "ERROR", error: { message: "You have exceeded the monthly quota" } }));
    await expect(jsearch.search(query, ninja, null)).rejects.toMatchObject({ problem: "quota" });
  });

  it("waits longer than other sources before giving up", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    stubFetch(() => json(jsearchV2LastPage));
    await jsearch.search(query, ninja, null);
    expect(timeout).toHaveBeenCalledWith(45_000);
    timeout.mockRestore();
  });
});
