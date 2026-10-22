import { describe, expect, it } from "vitest";

import { leadFromHnPost } from "./hn";
import { companyFromHeadline, leadFromNewsItem, NEWS_FEEDS, rssItems } from "./news";
import { leadFromYc, ycReachable } from "./yc";

describe("Hacker News 'Who is hiring' posts", () => {
  const post = (text: string) => ({ id: 41000001, author: "acme", created_at: "2026-10-02T10:00:00Z", text });

  it("reads a post for Bengaluru or remote, with the address to write to", () => {
    const lead = leadFromHnPost(
      post("Tiller (YC W24) | Senior Android Engineer | Bengaluru or REMOTE (India) | Seed<p>We build offline-first field apps in Kotlin and Jetpack Compose. Write to jobs [at] tiller [dot] app with your GitHub. https:&#x2F;&#x2F;tiller.app"),
    )!;
    expect(lead).toMatchObject({
      source: "HN",
      externalId: "41000001",
      company: "Tiller",
      website: "https://tiller.app",
      remote: true,
      stage: "Seed",
      roles: ["Senior Android Engineer"],
      emails: [{ email: "jobs@tiller.app", label: "Hiring", from: "https://news.ycombinator.com/item?id=41000001" }],
      postedAt: "2026-10-02T10:00:00Z",
    });
    expect(lead.location).toContain("Bengaluru");
  });

  it("leaves out posts only for people elsewhere", () => {
    expect(leadFromHnPost(post("Acme | Backend Engineer | ONSITE San Francisco, CA"))).toBeNull();
    expect(leadFromHnPost(post("Acme | Backend Engineer | REMOTE (US only)"))).toBeNull();
    expect(leadFromHnPost(post("Acme | Backend Engineer | REMOTE worldwide"))).not.toBeNull();
  });
});

describe("funding news", () => {
  it("reads the company and the round from a headline", () => {
    expect(companyFromHeadline("Enterprise AI Startup AuxoAI Nets $20.7M To Strengthen Its FDE Team")).toMatchObject({ company: "AuxoAI" });
    expect(companyFromHeadline("Peak XV-Backed AI Startup Blacksmith Nets $66 Mn At A Unicorn Valuation")).toMatchObject({ company: "Blacksmith" });
    expect(companyFromHeadline("Otter AI raises $320M from General Catalyst's growth fund")).toMatchObject({ company: "Otter AI" });
    expect(companyFromHeadline("SpaceX alum's aviation startup, Reliable Robotics, lands $115M, topping $1B valuation")).toMatchObject({ company: "Reliable Robotics" });
    expect(companyFromHeadline("Kirana app Dukaan Bags ₹40 Cr In Series A Round")).toMatchObject({ company: "Dukaan" });
    expect(companyFromHeadline("Kirana app Dukaan Bags ₹40 Cr In Series A Round")?.round).toContain("Series A");
  });

  it("skips headlines that aren't about a round", () => {
    expect(companyFromHeadline("Eternal's Q2 Profit Surges 92% YoY to ₹125 Cr")).toBeNull();
    expect(companyFromHeadline("SBI Flags Exposure Of 3,897 Customer Records On Dark Web")).toBeNull();
  });

  it("reads an RSS feed's items into leads", () => {
    const xml = `<rss version="2.0"><channel>
      <item><title><![CDATA[Enterprise AI Startup AuxoAI Nets $20.7M To Strengthen Its FDE Team]]></title><link>https://inc42.com/buzz/auxoai/</link>
      <pubDate>Wed, 21 Oct 2026 11:33:17 +0000</pubDate><category><![CDATA[Funding]]></category><category><![CDATA[Enterprise Tech]]></category>
      <description><![CDATA[<p>AuxoAI has raised funding.</p>]]></description></item>
      <item><title>SBI Flags Exposure Of Customer Records</title><link>https://inc42.com/buzz/sbi/</link><pubDate>Wed, 21 Oct 2026 06:02:52 +0000</pubDate></item>
    </channel></rss>`;
    const leads = rssItems(xml).flatMap((item) => leadFromNewsItem(item, NEWS_FEEDS[0]) ?? []);
    expect(leads).toEqual([
      expect.objectContaining({ source: "INC42", company: "AuxoAI", location: "India", tags: ["Enterprise Tech"], postedAt: "2026-10-21T11:33:17.000Z", links: [{ label: "The news", url: "https://inc42.com/buzz/auxoai/" }] }),
    ]);
  });
});

describe("YC companies hiring", () => {
  const company = {
    id: 1, name: "Razorpay", slug: "razorpay", website: "https://razorpay.com", one_liner: "Payments for India", long_description: "Full-stack payments.",
    team_size: 3000, industries: ["Fintech"], tags: ["Payments"], regions: ["India", "South Asia"], all_locations: "Bengaluru, KA, India",
    batch: "Winter 2015", stage: "Growth", status: "Active", isHiring: true, launched_at: 1420070400, url: "https://www.ycombinator.com/companies/razorpay",
  };

  it("keeps companies in India or hiring remotely", () => {
    expect(ycReachable(company)).toEqual({ india: true, remote: false });
    expect(ycReachable({ regions: ["United States of America", "Remote"], all_locations: "San Francisco" })).toEqual({ india: false, remote: true });
    expect(ycReachable({ regions: ["United Kingdom"], all_locations: "London" })).toEqual({ india: false, remote: false });
  });

  it("reads a company as a lead", () => {
    expect(leadFromYc(company)).toMatchObject({
      source: "YC",
      externalId: "razorpay",
      company: "Razorpay",
      website: "https://razorpay.com",
      summary: "Payments for India",
      location: "Bengaluru, KA, India",
      stage: "YC W15 · Growth",
      teamSize: 3000,
      tags: ["Fintech", "Payments"],
      links: [
        { label: "Website", url: "https://razorpay.com" },
        { label: "YC profile", url: "https://www.ycombinator.com/companies/razorpay" },
        { label: "Open roles", url: "https://www.ycombinator.com/companies/razorpay/jobs" },
      ],
    });
  });
});
