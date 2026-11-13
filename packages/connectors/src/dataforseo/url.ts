/**
 * URL keys for SERP-overlap clustering (ADR 0003). Two results count as the same page
 * only when their keys match, so normalisation decides cluster quality.
 */

const TRACKING = /^(utm_.*|gclid|fbclid|msclkid|srsltid|ved|ei|sa|usg|_ga|mc_.*)$/i;

/** Google redirect links that hide the real URL. */
export function isGoogleRedirect(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)google\.[a-z.]+$/.test(u.hostname) && /^\/(goto|url|aclk)$/.test(u.pathname);
  } catch {
    return false;
  }
}

/** Normalised key: host without www, path without trailing slash, no tracking params, no scheme. */
export function normalizeUrl(url: string): string {
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  let path = decodeURIComponent(u.pathname).replace(/\/+$/, "");
  if (path === "") path = "/";
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  return `${host}${path === "/" ? "" : path.toLowerCase()}${query}`;
}

/**
 * Fallback when Google only gives a redirect: rebuild a key from the breadcrumb,
 * e.g. "https://www.axians.nl › marktsegment › industrie › erp-..." → "axians.nl/marktsegment/industrie/erp-…".
 * Truncated segments keep a "…" marker so the key is honest about being partial.
 */
export function keyFromBreadcrumb(breadcrumb: string): string | null {
  const parts = breadcrumb
    .split("›")
    .map((p) => p.trim())
    .filter(Boolean);
  const origin = parts.shift();
  if (!origin) return null;
  let host: string;
  try {
    host = new URL(origin.startsWith("http") ? origin : `https://${origin}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/^www\./, "");
  const path = parts.map((p) => p.toLowerCase().replace(/\.{3}$|…$/, "…")).join("/");
  return path ? `${host}/${path}` : host;
}

export type UrlSource = "url" | "breadcrumb" | "domain";

/** Best available key for an organic result, and how trustworthy it is. */
export function resultKey(item: {
  url?: string | null;
  breadcrumb?: string | null;
  domain?: string | null;
  website_name?: string | null;
}): { key: string; source: UrlSource } | null {
  if (item.url && !isGoogleRedirect(item.url)) {
    try {
      return { key: normalizeUrl(item.url), source: "url" };
    } catch {
      // fall through to the breadcrumb: a malformed url is not fatal for one result
    }
  }
  if (item.breadcrumb) {
    const key = keyFromBreadcrumb(item.breadcrumb);
    if (key) return { key, source: "breadcrumb" };
  }
  // domain first: website_name is often a display name ("intratuin", "Bakker.com | Nederland").
  const domain = [item.domain, item.website_name]
    .map((d) =>
      d
        ?.trim()
        .toLowerCase()
        .replace(/^www\./, ""),
    )
    .find((d) => d && isHost(d) && !/(^|\.)google\./.test(d));
  return domain ? { key: domain, source: "domain" } : null;
}

const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** A bare host name like "bol.com" or "nl.example.org"; not a display name. */
export function isHost(s: string): boolean {
  return HOST.test(s);
}

/** The host a result key starts with ("bol.com/kamerplanten" → "bol.com"), or null. */
export function hostOfKey(key: string): string | null {
  const host = key.split("/")[0] ?? "";
  return isHost(host) ? host : null;
}
