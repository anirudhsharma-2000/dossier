import "server-only";

import { appVersion } from "@/lib/version";

// Requests to the startup sources. Each has a fixed public address, so
// there's nothing to guard against; requests are limited in time and size.

const TIMEOUT_MS = 20_000;
/** YC's list of companies hiring is a few megabytes. */
const MAX_BYTES = 25 * 1024 * 1024;

export class SourceError extends Error {
  override name = "SourceError";
}

/** GETs a source's address as text, or throws a SourceError saying why. */
export async function getText(url: string, { signal }: { signal?: AbortSignal } = {}): Promise<string> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "user-agent": `Mozilla/5.0 (compatible; Dossier/${appVersion}; self-hosted job search)`, accept: "application/json, application/rss+xml, text/xml, */*" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      cache: "no-store",
    });
  } catch {
    throw new SourceError(timeout.aborted ? "timed out" : "couldn't be reached");
  }
  if (!response.ok) throw new SourceError(`answered ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new SourceError("answer too big");
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new SourceError("answer too big");
  return text;
}

export async function getJson(url: string, options: { signal?: AbortSignal } = {}): Promise<unknown> {
  const text = await getText(url, options);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SourceError("didn't answer with JSON");
  }
}
