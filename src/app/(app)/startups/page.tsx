import type { Metadata } from "next";

import { findUnfinishedJobs } from "@/lib/jobs/runner";
import { lastRefresh, LEADS_JOB_KEY } from "@/lib/leads/refresh";
import { listLeads } from "@/lib/leads/store";
import { leadFilterFromParams } from "@/lib/leads/types";
import { loadProfile } from "@/lib/profile-data";

import { StartupsScreen } from "./startups-screen";

export const metadata: Metadata = { title: "Startups" };

/**
 * Startups worth writing to: hiring on YC or Hacker News, or just funded,
 * ranked against the profile, with the addresses they publish.
 */
export default async function StartupsPage({ searchParams }: PageProps<"/startups">) {
  const filter = leadFilterFromParams(await searchParams);
  const profile = await loadProfile();
  const [list, refreshed, [running]] = await Promise.all([
    listLeads(filter, { city: profile.basics.city }),
    lastRefresh(),
    findUnfinishedJobs(LEADS_JOB_KEY),
  ]);
  return (
    <StartupsScreen
      filter={filter}
      list={list}
      lastRefresh={refreshed}
      refreshJobId={running?.id ?? null}
      city={profile.basics.city.trim()}
      headline={profile.basics.headline.trim()}
      today={new Date().toISOString()}
    />
  );
}
