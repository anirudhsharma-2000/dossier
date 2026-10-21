import "server-only";

// Dossier was made to run as one long-lived server (Docker). On Vercel it
// runs as serverless functions instead: each request may reach a different
// instance, an instance is paused once its response is done (and work it
// was asked to finish with waitUntil()), nothing runs between requests, and
// there's no lasting disk. Code that depends on a long-lived process asks
// here which way it's running.

/** Whether the app runs as serverless functions (Vercel) rather than one long-lived server. */
export function isServerless(): boolean {
  return Boolean(process.env.VERCEL) || process.env.DOSSIER_SERVERLESS === "1";
}

/**
 * The longest a serverless function may run, in seconds: Vercel's Hobby
 * plan allows 300 with Fluid compute. Work that would take longer is cut off.
 */
export const SERVERLESS_MAX_SECONDS = 300;

/**
 * Where the app is reached from the server itself, for headless Chromium to
 * open print pages: DOSSIER_PUBLIC_URL when set, else the Vercel project's
 * production domain, else the local server.
 */
export function selfOrigin(): string {
  const configured = process.env.DOSSIER_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (configured) return new URL(configured).origin;
  if (isServerless()) {
    // Deployment Protection covers a deployment's own URL, but not the production domain.
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    if (host) return `https://${host}`;
  }
  return `http://localhost:${process.env.PORT ?? 3000}`;
}
