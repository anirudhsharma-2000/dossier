import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient, resetDatabase } from "@/test/db";

import { refreshLeads } from "./refresh";
import { findLeadEmails, listLeads, upsertLeads, updateLead } from "./store";
import { leadFilterSchema, type FoundLead } from "./types";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/profile-data", () => ({
  loadProfile: async () => ({
    basics: { headline: "Android engineer", city: "Bengaluru", country: "India", summary: "" },
    skills: [{ id: "1", name: "Android" }, { id: "2", name: "Kotlin" }],
    languages: [], experience: [], projects: [], education: [], references: [],
  }),
}));
vi.mock("@/lib/log", () => ({ logServerError: vi.fn() }));
// Sites and sources answer from here, never the internet.
const web = vi.hoisted(() => ({ emails: [] as { email: string; label: string; from: string }[] }));
vi.mock("./emails", async (importOriginal) => ({ ...(await importOriginal<typeof import("./emails")>()), findSiteEmails: vi.fn(async () => web.emails) }));
const sources = vi.hoisted(() => ({ yc: [] as unknown[], hnFails: false }));
vi.mock("./sources/yc", () => ({ fetchYcLeads: async () => sources.yc }));
vi.mock("./sources/hn", async () => {
  const { SourceError } = await import("./http");
  return { fetchHnLeads: async () => { if (sources.hnFails) throw new SourceError("timed out"); return []; } };
});
vi.mock("./sources/news", () => ({ NEWS_FEEDS: [], fetchNewsLeads: async () => [] }));
vi.mock("@/lib/jobs/runner", () => ({ defineJob: <T,>(definition: T) => definition, findUnfinishedJobs: async () => [], startJob: vi.fn() }));

const prisma = () => db.client!;
const filter = (change: object = {}) => leadFilterSchema.parse(change);
const lead = (change: Partial<FoundLead>): FoundLead => ({
  source: "YC", externalId: "acme", company: "Acme", website: "https://acme.io", summary: "Android apps for farmers", details: "Kotlin, Android.", location: "Bengaluru, India",
  remote: false, stage: "YC W24", teamSize: 12, tags: ["Agriculture"], roles: [], emails: [], links: [], postedAt: null, ...change,
});

beforeEach(async () => {
  await resetDatabase(prisma());
  web.emails = [];
  sources.yc = [];
  sources.hnFails = false;
});
afterAll(() => prisma().$disconnect());

describe("startup leads", () => {
  it("are kept and scored, and a refresh keeps what the user did with them", async () => {
    expect(await upsertLeads([lead({}), lead({ externalId: "far", company: "Faraway", details: "Hardware.", location: "London", website: "" })])).toBe(2);
    const [best, other] = (await listLeads(filter())).leads;
    expect(best).toMatchObject({ company: "Acme", status: "NEW" });
    expect(best.score).toBeGreaterThan(other.score);
    expect(best.reasons).toContain("In Bengaluru");

    await updateLead(best.id, { status: "SAVED", notes: "Write to Priya" });
    expect(await upsertLeads([lead({ summary: "Android apps for farmers, now in Hindi" })])).toBe(0);
    const saved = (await listLeads(filter({ status: "SAVED" }))).leads[0];
    expect(saved).toMatchObject({ summary: "Android apps for farmers, now in Hindi", notes: "Write to Priya", status: "SAVED" });
  });

  it("are filtered by words, place, source, score and having an address", async () => {
    await upsertLeads([
      lead({}),
      lead({ source: "HN", externalId: "1", company: "Remotely", location: "REMOTE", remote: true, emails: [{ email: "jobs@remotely.dev", label: "Hiring", from: "" }] }),
      lead({ source: "INC42", externalId: "https://inc42.com/x", company: "Fundly", location: "India", website: "", details: "Fintech" }),
    ]);
    const names = async (change: object) => (await listLeads(filter(change), { city: "Bengaluru" })).leads.map((entry) => entry.company).sort();
    expect(await names({ place: "city" })).toEqual(["Acme"]);
    expect(await names({ place: "remote" })).toEqual(["Remotely"]);
    expect(await names({ place: "india" })).toEqual(["Acme", "Fundly"]);
    expect(await names({ withEmail: true })).toEqual(["Remotely"]);
    expect(await names({ source: "INC42" })).toEqual(["Fundly"]);
    expect(await names({ q: "fintech" })).toEqual(["Fundly"]);
    expect((await listLeads(filter())).counts).toEqual({ NEW: 3, SAVED: 0, CONTACTED: 0, DISMISSED: 0 });
  });

  it("get the addresses their site publishes, ranked, and score higher for them", async () => {
    await upsertLeads([lead({})]);
    const [before] = (await listLeads(filter())).leads;
    web.emails = [
      { email: "hello@acme.io", label: "General", from: "https://acme.io/contact" },
      { email: "careers@acme.io", label: "Hiring", from: "https://acme.io/careers" },
    ];
    const after = (await findLeadEmails(before.id))!;
    expect(after.emails.map((entry) => entry.email)).toEqual(["careers@acme.io", "hello@acme.io"]);
    expect(after.emailsCheckedAt).not.toBeNull();
    expect(after.score).toBeGreaterThan(before.score);
  });

  it("refresh from every source, and one failing doesn't stop the rest", async () => {
    sources.yc = [lead({})];
    sources.hnFails = true;
    web.emails = [{ email: "jobs@acme.io", label: "Hiring", from: "https://acme.io/jobs" }];
    const result = await refreshLeads();
    expect(result).toMatchObject({ added: 1, emailsFound: 1 });
    expect(result.sources).toEqual([
      { source: "YC", found: 1, error: null },
      { source: "HN", found: 0, error: "Hacker News timed out" },
    ]);
    expect((await listLeads(filter())).leads[0].emails[0].email).toBe("jobs@acme.io");
  });
});
