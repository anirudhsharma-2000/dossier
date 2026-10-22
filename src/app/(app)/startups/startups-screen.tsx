"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent, type ReactNode } from "react";

import { PageHeader } from "@/components/page-header";
import { ScoreBadge } from "@/components/score-badge";
import { toast, toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useJob } from "@/hooks/use-job";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/dates";
import { postedAgo } from "@/lib/job-search/search";
import { LEAD_SOURCE_INFO, LEAD_SOURCES, leadFilterHref, type LeadEmail, type LeadFilter, type LeadStatusName, type LeadView } from "@/lib/leads/types";

import { openPendingTab, sendPendingTab } from "../jobs/claude-tab";
import { findStartupEmails, refreshStartups, setStartupStatus, writeStartupEmail } from "./actions";

type RefreshResult = { at: string; added: number; emailsFound: number; sources: { source: string; found: number; error: string | null }[] };

export type StartupsScreenProps = {
  filter: LeadFilter;
  list: { leads: LeadView[]; total: number; counts: Record<LeadStatusName, number> };
  lastRefresh: RefreshResult | null;
  refreshJobId: string | null;
  /** The profile's city, for "In Bengaluru". */
  city: string;
  /** The profile's headline, for an email's subject. */
  headline: string;
  today: string;
};

const VIEWS: { status: LeadStatusName; label: string }[] = [
  { status: "NEW", label: "To look at" },
  { status: "SAVED", label: "Saved" },
  { status: "CONTACTED", label: "Contacted" },
  { status: "DISMISSED", label: "Dismissed" },
];

/**
 * The Startups screen: startups hiring on YC or Hacker News, or just funded,
 * ranked against the profile, with the addresses they publish. Writing to
 * them happens in the user's own mail, or with Claude; Dossier sends nothing.
 */
export function StartupsScreen({ filter, list, lastRefresh, refreshJobId, city, headline, today }: StartupsScreenProps) {
  const router = useRouter();
  const [jobId, setJobId] = useState(refreshJobId);
  const [starting, startTransition] = useTransition();

  const job = useJob<RefreshResult>(jobId, 0, (update) => {
    if (update.status !== "DONE" && update.status !== "FAILED") return;
    setJobId(null);
    if (update.status === "FAILED") return toast(update.error ?? "The refresh didn't finish. Try again.");
    const result = update.result;
    toast(result ? `Found ${result.added} new ${result.added === 1 ? "startup" : "startups"}.` : "Refreshed.");
    router.refresh();
  });
  const refreshing = Boolean(jobId) && (!job || job.status === "QUEUED" || job.status === "RUNNING");

  const refresh = () =>
    startTransition(async () => {
      const result = toastResult(await refreshStartups({}));
      if (result.ok) setJobId(result.data.jobId);
    });

  const go = (change: Partial<LeadFilter>) => router.replace(leadFilterHref({ ...filter, ...change }), { scroll: false });

  return (
    <>
      <PageHeader
        title="Startups"
        description="Startups hiring on Y Combinator and Hacker News, and ones that just raised money, ranked against your profile, with the addresses they publish. Write to them from your own mail, or let Claude write the email."
        actions={
          <Button aria-disabled={refreshing || starting || undefined} onClick={() => !refreshing && !starting && refresh()}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />
      <div className="flex flex-col gap-6 px-10 pb-20">
        <RefreshStatus lastRefresh={lastRefresh} refreshing={refreshing} step={job?.step ?? null} today={today} />
        <ViewTabs filter={filter} counts={list.counts} />
        <Filters filter={filter} city={city} onChange={go} />

        {list.leads.length === 0 ? (
          <Empty filter={filter} hasAny={Object.values(list.counts).some((count) => count > 0)} />
        ) : (
          <>
            <p className="text-meta text-muted">
              {list.total > list.leads.length ? `The best ${list.leads.length} of ${list.total}` : `${list.total} ${list.total === 1 ? "startup" : "startups"}`}
              {filter.sort === "match" ? ", best match first." : ", newest first."}
            </p>
            <ul className="flex flex-col gap-3">
              {list.leads.map((lead) => (
                <li key={`${lead.id}:${lead.status}:${lead.emails.length}:${lead.score}`}>
                  <LeadCard lead={lead} headline={headline} today={today} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}

function RefreshStatus({ lastRefresh, refreshing, step, today }: { lastRefresh: RefreshResult | null; refreshing: boolean; step: string | null; today: string }) {
  if (refreshing) {
    return (
      <p role="status" className="rounded-card border border-line-card bg-card px-4 py-3 text-meta text-muted">
        {step ?? "Starting…"} This takes a minute or two.
      </p>
    );
  }
  if (!lastRefresh) {
    return (
      <p role="note" className="rounded-card border border-line-card bg-card px-4 py-3 text-meta text-muted">
        Nothing here yet. Press <strong className="text-ink">Refresh</strong> to look for startups. After that it runs once a day on its own.
      </p>
    );
  }
  const failed = lastRefresh.sources.filter((source) => source.error);
  return (
    <div className="flex flex-col gap-2 text-meta text-muted">
      <p>
        Last refreshed {formatDateTime(new Date(lastRefresh.at), undefined, new Date(today))}:{" "}
        {lastRefresh.sources
          .filter((source) => !source.error)
          .map((source) => `${LEAD_SOURCE_INFO[source.source as keyof typeof LEAD_SOURCE_INFO]?.name ?? source.source} ${source.found}`)
          .join(" · ")}
        .
      </p>
      {failed.length > 0 && (
        <p role="note" className="rounded-card bg-warning-surface px-4 py-2.5 text-warning">
          {failed.map((source) => source.error).join("; ")}. The others worked; it tries again on the next refresh.
        </p>
      )}
    </div>
  );
}

function ViewTabs({ filter, counts }: { filter: LeadFilter; counts: Record<LeadStatusName, number> }) {
  return (
    <nav aria-label="Startups views" className="flex flex-wrap gap-1.5">
      {VIEWS.map((view) => (
        <Link
          key={view.status}
          href={leadFilterHref({ ...filter, status: view.status })}
          aria-current={view.status === filter.status ? "page" : undefined}
          className={cn(
            "flex items-baseline gap-1.5 rounded-control border px-3 py-2 text-control",
            view.status === filter.status
              ? "border-primary bg-selected font-medium text-primary-text hover:text-primary-text"
              : "border-line-field bg-card text-ink hover:border-line-strong hover:bg-hover hover:text-ink",
          )}
        >
          {view.label}
          <span className="text-xs opacity-65">{counts[view.status]}</span>
        </Link>
      ))}
    </nav>
  );
}

function Filters({ filter, city, onChange }: { filter: LeadFilter; city: string; onChange: (change: Partial<LeadFilter>) => void }) {
  const [q, setQ] = useState(filter.q);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onChange({ q: q.trim() });
  };
  return (
    <form role="search" aria-label="Filter startups" onSubmit={submit} className="grid grid-cols-1 items-end gap-4 rounded-panel border border-line-card bg-card p-6 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr]">
      <Input label="Search" value={q} placeholder="e.g. android, fintech, Series A" onChange={(event) => setQ(event.target.value)} onBlur={() => q.trim() !== filter.q && onChange({ q: q.trim() })} />
      <Select label="Where" value={filter.place} onChange={(event) => onChange({ place: event.target.value as LeadFilter["place"] })}>
        <option value="any">Anywhere</option>
        {city && <option value="city">{city}</option>}
        <option value="india">India</option>
        <option value="remote">Remote</option>
      </Select>
      <Select label="Source" value={filter.source} onChange={(event) => onChange({ source: event.target.value as LeadFilter["source"] })}>
        <option value="">All sources</option>
        {LEAD_SOURCES.map((source) => (
          <option key={source} value={source}>
            {LEAD_SOURCE_INFO[source].name}
          </option>
        ))}
      </Select>
      <Select label="Match" value={String(filter.minScore)} onChange={(event) => onChange({ minScore: Number(event.target.value) })}>
        <option value="0">Any</option>
        <option value="50">50 and up</option>
        <option value="70">70 and up</option>
        <option value="85">85 and up</option>
      </Select>
      <Select label="Sort" value={filter.sort} onChange={(event) => onChange({ sort: event.target.value as LeadFilter["sort"] })}>
        <option value="match">Best match</option>
        <option value="newest">Newest</option>
      </Select>
      <div className="sm:col-span-2 lg:col-span-5">
        <Checkbox label="Only ones with an email to write to" checked={filter.withEmail} onChange={(event) => onChange({ withEmail: event.target.checked })} />
      </div>
    </form>
  );
}

function Empty({ filter, hasAny }: { filter: LeadFilter; hasAny: boolean }) {
  const filtered = filter.q || filter.place !== "any" || filter.source || filter.minScore > 0 || filter.withEmail;
  return (
    <p className="rounded-panel border border-dashed border-line-strong px-7 py-10 text-center text-sm text-muted">
      {!hasAny
        ? "No startups yet. Press Refresh to look for some."
        : filtered
          ? "None match these filters. Try fewer."
          : filter.status === "NEW"
            ? "Nothing new to look at. The next refresh brings more."
            : "None here yet."}
    </p>
  );
}

/** "Interested in engineering roles at Acme": a subject for writing from the user's own mail. */
const mailto = (email: string, company: string, headline: string) =>
  `mailto:${email}?subject=${encodeURIComponent(`${headline || "Engineer"}, interested in joining ${company}`)}`;

function LeadCard({ lead: initial, headline, today }: { lead: LeadView; headline: string; today: string }) {
  const router = useRouter();
  const [lead, setLead] = useState(initial);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const info = LEAD_SOURCE_INFO[lead.source];
  const posted = lead.source === "YC" ? "" : postedAgo(lead.postedAt, new Date(today));

  const move = async (status: LeadStatusName, message: string) => {
    if (busy) return;
    setBusy(status);
    const before = lead.status;
    const result = toastResult(await setStartupStatus({ id: lead.id, status }));
    setBusy(null);
    if (!result.ok) return;
    toast(message, {
      action: {
        label: "Undo",
        onClick: () => void setStartupStatus({ id: lead.id, status: before }).then((undone) => toastResult(undone).ok && router.refresh()),
      },
    });
    router.refresh();
  };

  const lookForEmails = async () => {
    if (busy) return;
    setBusy("emails");
    const result = toastResult(await findStartupEmails({ id: lead.id }));
    setBusy(null);
    if (!result.ok) return;
    const added = result.data.emails.length - lead.emails.length;
    setLead({ ...lead, ...result.data });
    toast(added > 0 ? `Found ${added} ${added === 1 ? "address" : "addresses"} on their site.` : "Their site doesn't publish an address. Try Claude, or their careers page.");
  };

  const writeWithClaude = async () => {
    if (busy) return;
    const chat = openPendingTab();
    setBusy("claude");
    const result = toastResult(await writeStartupEmail({ id: lead.id }));
    setBusy(null);
    if (!result.ok) return void chat?.close();
    sendPendingTab(chat, result.data.url);
  };

  return (
    <article className="flex flex-col gap-4 rounded-panel border border-line-card bg-card px-6 py-5">
      <div className="flex items-start gap-4">
        <ScoreBadge score={lead.score} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="font-serif text-section">{lead.company}</h3>
            <span className="rounded-full border border-line-field px-2 py-0.5 text-xs text-muted">
              {info.name} · {info.kind}
            </span>
          </div>
          <p className="text-sm text-pretty">{lead.summary}</p>
          <p className="text-meta text-muted">{[lead.location, lead.remote ? "Remote" : "", lead.stage, lead.teamSize ? `${lead.teamSize} people` : "", posted].filter(Boolean).join(" · ")}</p>
        </div>
      </div>

      {lead.roles.length > 0 && (
        <ul aria-label="Roles" className="flex flex-wrap gap-1.5">
          {lead.roles.map((role) => (
            <li key={role} className="rounded-full border border-line-field bg-input px-2.5 py-1 text-xs">
              {role}
            </li>
          ))}
        </ul>
      )}

      {lead.reasons.length > 0 && <p className="text-meta text-muted">{lead.reasons.join(" · ")}</p>}

      <Emails emails={lead.emails} company={lead.company} headline={headline} />

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" aria-disabled={busy !== null || undefined} onClick={() => void writeWithClaude()}>
          {busy === "claude" ? "Opening Claude…" : "Write the email with Claude"}
        </Button>
        {lead.website && (
          <Button size="sm" variant="secondary" aria-disabled={busy !== null || undefined} onClick={() => void lookForEmails()}>
            {busy === "emails" ? "Looking…" : lead.emailsCheckedAt ? "Look for emails again" : "Find emails on their site"}
          </Button>
        )}
        {lead.status !== "SAVED" && lead.status !== "CONTACTED" && (
          <Button size="sm" variant="secondary" aria-disabled={busy !== null || undefined} onClick={() => void move("SAVED", `Saved ${lead.company}.`)}>
            Save
          </Button>
        )}
        {lead.status !== "CONTACTED" && (
          <Button size="sm" variant="secondary" aria-disabled={busy !== null || undefined} onClick={() => void move("CONTACTED", `Marked ${lead.company} as contacted.`)}>
            Mark contacted
          </Button>
        )}
        {lead.status === "DISMISSED" || lead.status === "CONTACTED" ? (
          <Button size="sm" variant="text" onClick={() => void move("NEW", `${lead.company} is back in To look at.`)}>
            Move back
          </Button>
        ) : (
          <Button size="sm" variant="danger-text" className="ml-auto" onClick={() => void move("DISMISSED", `Dismissed ${lead.company}.`)}>
            Dismiss
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-meta">
        {lead.links.map((link) => (
          <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" className="text-muted underline underline-offset-2 hover:text-ink">
            {link.label} ↗
          </a>
        ))}
        {lead.details && lead.details !== lead.summary && (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="ml-auto text-muted underline underline-offset-2 hover:text-ink">
            {open ? "Hide details" : "Details"}
          </button>
        )}
      </div>
      {open && <p className="max-h-80 overflow-y-auto text-sm whitespace-pre-wrap text-document">{lead.details}</p>}
    </article>
  );
}

function Emails({ emails, company, headline }: { emails: LeadEmail[]; company: string; headline: string }): ReactNode {
  if (emails.length === 0) return null;
  const copy = (email: string) =>
    void navigator.clipboard.writeText(email).then(
      () => toast(`Copied ${email}.`),
      () => toast("Couldn't copy it. Select the address instead."),
    );
  return (
    <ul aria-label="Addresses they publish" className="flex flex-col gap-1.5">
      {emails.map((entry) => (
        <li key={entry.email} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="w-20 text-meta text-muted">{entry.label}</span>
          <a href={mailto(entry.email, company, headline)} className="font-medium underline underline-offset-2">
            {entry.email}
          </a>
          <button type="button" onClick={() => copy(entry.email)} className="text-meta text-muted underline underline-offset-2 hover:text-ink">
            Copy
          </button>
          {entry.from && /^https?:\/\//.test(entry.from) && (
            <a href={entry.from} target="_blank" rel="noopener noreferrer" className="text-meta text-muted hover:text-ink">
              where it&apos;s published ↗
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
