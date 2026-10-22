// Reading leads' text: HTML from posts and feeds to plain text, the email
// addresses people publish (also written as "jane [at] acme [dot] com"),
// and a site's domain. Pure functions, shared by the sources and tests.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

/** Decodes HTML entities: named, decimal and hex. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** HTML as plain text, with paragraphs and line breaks kept, and links written as their address. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
        const url = decodeEntities(href);
        const text = label.replace(/<[^>]+>/g, "").trim();
        return text && decodeEntities(text) !== url ? `${text} (${url})` : url;
      })
      .replace(/<\s*(p|br|li|div|h\d)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
/** Addresses that are never people to write to: images, tracking, examples. */
const NOT_A_CONTACT = /\.(png|jpe?g|gif|svg|webp|css|js)$|@(example|sentry|wixpress|sentry-next|domain|email)\.|^(no-?reply|donotreply|mailer-daemon|privacy|abuse|legal|security|dmca|unsubscribe)@/i;

/**
 * The email addresses in some text, once each, lower case. Undoes the usual
 * ways of hiding them from scrapers: "jane [at] acme [dot] com",
 * "jane(at)acme.com", "jane at acme dot com".
 */
export function findEmails(text: string): string[] {
  const plain = text
    .replace(/\s*[[({<]\s*at\s*[\])}>]\s*/gi, "@")
    .replace(/\s*[[({<]\s*dot\s*[\])}>]\s*/gi, ".")
    .replace(/\b([a-z0-9._%+-]+)\s+at\s+([a-z0-9-]+(?:\s+dot\s+[a-z0-9-]+)+)\b/gi, (_, name: string, host: string) => `${name}@${host.replace(/\s+dot\s+/gi, ".")}`);
  const found = new Set<string>();
  for (const match of plain.matchAll(EMAIL)) {
    const email = match[0].replace(/\.+$/, "").toLowerCase();
    if (!NOT_A_CONTACT.test(email)) found.add(email);
  }
  return [...found];
}

/** What an address is for, from its name: "Hiring", "Founders" or "General". */
export function emailLabel(email: string): string {
  const name = email.split("@")[0].toLowerCase();
  if (/^(careers?|jobs?|hiring|recruit(ing|ment)?|talent|hr|people|join(us)?|work)\b/.test(name)) return "Hiring";
  if (/^(founders?|ceo|cto|team-?lead)\b/.test(name)) return "Founders";
  if (/^(hello|hi|hey|contact|info|team|support|sales|admin|office)\b/.test(name)) return "General";
  return "Person";
}

/** The site's domain without "www.", e.g. "acme.com"; "" for something that isn't a web address. */
export function domainOf(url: string): string {
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? hostname.replace(/^www\./i, "").toLowerCase() : "";
  } catch {
    return "";
  }
}

/** Whether an address belongs to the site (its domain or a subdomain of it). */
export function emailOnDomain(email: string, domain: string): boolean {
  const host = email.split("@")[1] ?? "";
  return Boolean(domain) && (host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`));
}

/** The first web address in some text, for a lead's site when the post names one. */
export function firstLink(text: string): string {
  return /https?:\/\/[^\s)<>"']+/i.exec(text)?.[0].replace(/[.,;:!?]+$/, "") ?? "";
}

/** A short line from a longer text: its first sentence, cut at `max` characters. */
export function firstLine(text: string, max = 220): string {
  const line = text.split("\n").find((entry) => entry.trim()) ?? "";
  return line.length <= max ? line.trim() : `${line.slice(0, max - 1).trimEnd()}…`;
}
