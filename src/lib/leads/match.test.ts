import { describe, expect, it } from "vitest";

import type { ProfileData } from "@/lib/profile";

import { matchLead } from "./match";
import type { FoundLead } from "./types";

const profile = {
  basics: { name: "Anirudh", headline: "Senior Software Engineer", city: "Bengaluru", country: "India", summary: "Mobile engineer, Kotlin and Jetpack Compose." },
  skills: ["Android", "Jetpack Compose", "Kotlin Flows", "Node.js", "React Native", "Agile"].map((name, index) => ({ id: String(index), name })),
  languages: [],
  experience: [{ id: "r1", role: "Senior Software Engineer", company: "Origin Fresh" }],
  projects: [],
  education: [],
  references: [],
} as unknown as ProfileData;

const lead = (change: Partial<FoundLead>): FoundLead => ({
  source: "HN", externalId: "1", company: "Acme", website: "", summary: "", details: "", location: "", remote: null, stage: "", teamSize: null,
  tags: [], roles: [], emails: [], links: [], postedAt: null, ...change,
});
const now = new Date("2026-10-22T10:00:00Z");

describe("matching a startup to the profile", () => {
  it("ranks a Bangalore Android startup with a hiring address high, and says why", () => {
    const fit = matchLead(
      lead({ details: "We build our Android app in Jetpack Compose, with a Node.js backend.", location: "Bangalore", roles: ["Android Engineer"], postedAt: "2026-10-15T00:00:00Z", emails: [{ email: "jobs@acme.io", label: "Hiring", from: "" }] }),
      profile,
      now,
    );
    expect(fit.score).toBeGreaterThanOrEqual(85);
    expect(fit.reasons).toEqual(["Mentions Android, Jetpack Compose and Node.js from your skills", "Does mobile work, like you", "In Bengaluru", "Posted this month", "Has an address for applications"]);
  });

  it("ranks an unrelated company elsewhere low, and ignores general skills", () => {
    const fit = matchLead(lead({ details: "Agile hardware manufacturing.", location: "London" }), profile, now);
    expect(fit.score).toBeLessThan(30);
    expect(fit.reasons).toEqual([]);
  });

  it("counts remote work and recent rounds", () => {
    const fit = matchLead(lead({ source: "INC42", remote: true, postedAt: "2026-10-20T00:00:00Z", location: "India" }), profile, now);
    expect(fit.reasons).toEqual(["In India", "Hires remotely", "Raised 2 days ago"]);
  });
});
