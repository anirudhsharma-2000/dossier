import "server-only";

import { randomUUID } from "node:crypto";

import { fullText } from "@/lib/job-search/find";
import type { FoundPosting } from "@/lib/job-search/search";
import { storePosting } from "@/lib/postings";
import { readStoredFile, storeFile } from "@/lib/stored-files";

// Handing work to Claude chat (no AI key in Dossier): the in-app buttons that
// need an AI model open a new chat in claude.ai instead, with a short prompt
// that names the posting by an id the Dossier connector can read. The chat
// runs on the user's own Claude subscription, through Anthropic's own app;
// Dossier never sees or stores Claude sign-in details.

/** A pasted posting waits this long for Claude to read it. */
const PASTE_DAYS = 14;

export type Handoff = "write" | "score";

/** A new claude.ai chat that starts with `prompt`. Prompts stay short: links over ~2,000 characters break. */
export const claudeChatUrl = (prompt: string) => `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;

const describe = (title: string, company: string) => [title, company].map((part) => part.trim()).filter(Boolean).join(" at ");

function promptFor(kind: Handoff, ref: string, about: string): string {
  const what = about ? `the job posting ${ref} (${about})` : `the job posting ${ref}`;
  if (kind === "score") {
    return (
      `Using my Dossier connector: score how well ${what} fits my profile. ` +
      "Read it with get_posting and my profile with get_profile, give a score from 0 to 100 with the reasons and any red flags, and save it with save_job_scores."
    );
  }
  return (
    `Using my Dossier connector: write a tailored resume and cover letter for ${what}. ` +
    "Read it with get_posting and my profile with get_profile. Use only facts from my profile and tell me about any gaps. " +
    "Show me a short summary and the fit, then save it with save_application."
  );
}

/** For a posting from Find jobs: keeps it with its whole text, and gives the chat to open. */
export async function handOffFoundPosting(posting: FoundPosting, kind: Handoff): Promise<string> {
  const text = posting.complete ? posting.description : await fullText(posting);
  const stored = await storePosting(text ? { ...posting, description: text, complete: true } : posting);
  return claudeChatUrl(promptFor(kind, `with posting_id "${stored.id}"`, describe(posting.title, posting.company)));
}

/** For a posting pasted into New application: keeps its text for Claude to read, and gives the chat to open. */
export async function handOffPastedPosting({ text, url }: { text: string; url: string }): Promise<string> {
  const id = randomUUID();
  await storeFile("paste", id, Buffer.from(JSON.stringify({ text, url })), {
    contentType: "application/json",
    expiresAt: new Date(Date.now() + PASTE_DAYS * 24 * 60 * 60 * 1000),
  });
  return claudeChatUrl(promptFor("write", `with paste_id "${id}"`, ""));
}

/** A pasted posting kept for Claude, or null once it's gone. */
export async function readPastedPosting(id: string): Promise<{ text: string; url: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const file = await readStoredFile("paste", id);
  if (!file) return null;
  try {
    const value = JSON.parse(Buffer.from(file.data).toString("utf8")) as { text?: unknown; url?: unknown };
    return typeof value.text === "string" ? { text: value.text, url: typeof value.url === "string" ? value.url : "" } : null;
  } catch {
    return null;
  }
}
