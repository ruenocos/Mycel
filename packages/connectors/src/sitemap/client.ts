import { gunzipSync } from "node:zlib";
import { FileCache, requestHash } from "../dataforseo/cache.ts";
import { withUserAgent } from "../http.ts";
import type { CallRecorder } from "../recorder.ts";

/**
 * Reads a site's XML sitemaps (issue #63, Koray steps 8 and 11): every page URL a competitor
 * publishes, with its last-modified date when the sitemap gives one. Free and cached.
 *
 * Sitemaps are published for crawlers, so this is the polite way to see a site's size. Plain
 * fetches only: a site that answers with a bot check or an error is marked blocked with the
 * reason, never worked around (CLAUDE.md, #16).
 */

const SERVICE = "sitemap";

export interface SitemapUrl {
  loc: string;
  /** YYYY-MM-DD, when the sitemap says. */
  lastmod?: string;
}

export interface SiteSitemap {
  domain: string;
  status: "ok" | "blocked" | "missing";
  reason?: string;
  /** The sitemap files read. */
  files: string[];
  urls: SitemapUrl[];
  /** It stopped at the file or URL cap. */
  truncated: boolean;
}

export interface SitemapOptions {
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  /** Sitemap files read per site. */
  maxFiles?: number;
  /** URLs kept per site. */
  maxUrls?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Pause between two files of one site. */
  pauseMs?: number;
}

/** Child sitemaps that list no content pages: authors, tags, media. */
const SKIP_CHILD = /(author|post_tag|[-_/]tags?[-_.]|attachment|image|video|format|user)/i;
const BOT_CHECK = /cf-chl|challenge-platform|just a moment\.\.\.|captcha|access denied/i;

const tag = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "gi"))].map((m) =>
    (m[1] ?? "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&")
      .trim(),
  );

/** `<sitemapindex>` children, or `<urlset>` URLs with their dates. */
export function parseSitemap(xml: string): { children: string[]; urls: SitemapUrl[] } {
  if (/<sitemapindex[\s>]/i.test(xml)) {
    return { children: tag(xml, "sitemap").flatMap((s) => tag(s, "loc").slice(0, 1)), urls: [] };
  }
  const urls: SitemapUrl[] = [];
  for (const u of tag(xml, "url")) {
    const [loc] = tag(u, "loc");
    if (!loc) continue;
    const [lastmod] = tag(u, "lastmod");
    const day = lastmod?.slice(0, 10);
    urls.push({ loc, ...(day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? { lastmod: day } : {}) });
  }
  return { children: [], urls };
}

/** `Sitemap:` lines in a robots.txt. */
export function robotsSitemaps(robots: string): string[] {
  return [...robots.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1] ?? "").filter(Boolean);
}

interface Fetched {
  status: number;
  text: string;
}

export class SitemapReader {
  private readonly cache: FileCache | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: SitemapOptions = {}) {
    this.cache = opts.cacheDir ? new FileCache(opts.cacheDir) : undefined;
    this.fetchImpl = withUserAgent(opts.fetchImpl ?? fetch);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async read(domain: string, rec: CallRecorder): Promise<SiteSitemap> {
    const maxFiles = this.opts.maxFiles ?? 40;
    const maxUrls = this.opts.maxUrls ?? 20_000;
    const origin = `https://${domain}`;
    const out: SiteSitemap = { domain, status: "missing", files: [], urls: [], truncated: false };

    const robots = await this.get(`${origin}/robots.txt`, rec);
    if (robots.blocked) return { ...out, status: "blocked", reason: robots.blocked };
    const listed = robots.res && robots.res.status < 400 ? robotsSitemaps(robots.res.text) : [];
    const queue = listed.length
      ? listed
      : [`${origin}/sitemap_index.xml`, `${origin}/sitemap.xml`, `${origin}/wp-sitemap.xml`];
    const seen = new Set<string>();
    const blocked: string[] = [];
    const seenUrls = new Set<string>();
    while (queue.length) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      if (seen.size >= maxFiles) {
        out.truncated = true;
        break;
      }
      seen.add(file);
      if (seen.size > 1) await this.sleep(this.opts.pauseMs ?? 250);
      const got = await this.get(file, rec);
      if (got.blocked) {
        blocked.push(got.blocked);
        continue;
      }
      if (!got.res || got.res.status >= 400 || !/<(urlset|sitemapindex)[\s>]/i.test(got.res.text)) {
        continue;
      }
      out.files.push(file);
      const parsed = parseSitemap(got.res.text);
      queue.push(...parsed.children.filter((c) => !SKIP_CHILD.test(c.split("/").pop() ?? "")));
      for (const u of parsed.urls) {
        if (seenUrls.has(u.loc)) continue;
        if (out.urls.length >= maxUrls) {
          out.truncated = true;
          break;
        }
        seenUrls.add(u.loc);
        out.urls.push(u);
      }
      // Without a sitemap listed in robots.txt, the first standard path that works is enough.
      if (!listed.length && out.urls.length) queue.length = 0;
    }
    if (out.files.length) return { ...out, status: "ok" };
    if (blocked.length) return { ...out, status: "blocked", reason: blocked[0] as string };
    return { ...out, reason: "no sitemap in robots.txt or at the usual paths" };
  }

  /** One GET, cached. `blocked` says why a site turned the request away. */
  private async get(url: string, rec: CallRecorder): Promise<{ res?: Fetched; blocked?: string }> {
    const hash = requestHash(`${SERVICE}:${url}`, {});
    const endpoint = url;
    const startedAt = new Date().toISOString();
    const cached = this.cache?.get<Fetched>(hash)?.result;
    if (cached) {
      rec.recordApiCall({
        service: SERVICE,
        endpoint,
        requestHash: hash,
        cache: "hit",
        costUsd: 0,
        latencyMs: 0,
        status: cached.status,
        startedAt,
      });
      return { res: cached, ...blockedBy(cached) };
    }
    const t0 = Date.now();
    let res: Fetched;
    try {
      const r = await this.fetchImpl(url, {
        headers: { Accept: "application/xml,text/xml,text/plain;q=0.9,*/*;q=0.5" },
        redirect: "follow",
      });
      const buf = Buffer.from(await r.arrayBuffer());
      const gz = buf[0] === 0x1f && buf[1] === 0x8b;
      res = { status: r.status, text: (gz ? gunzipSync(buf) : buf).toString("utf8") };
    } catch (err) {
      const e = err as Error;
      rec.recordApiCall({
        service: SERVICE,
        endpoint,
        requestHash: hash,
        cache: "miss",
        costUsd: 0,
        latencyMs: Date.now() - t0,
        status: "error",
        error: { name: e.name, message: e.message },
        startedAt,
      });
      return { blocked: `could not connect (${e.message})` };
    }
    rec.recordApiCall({
      service: SERVICE,
      endpoint,
      requestHash: hash,
      cache: this.cache ? "miss" : "bypass",
      costUsd: 0,
      latencyMs: Date.now() - t0,
      status: res.status,
      ...(res.status >= 400 ? { error: { name: "HttpError", message: `HTTP ${res.status}` } } : {}),
      startedAt,
    });
    // A bot check or a rate limit is not cached: the next run may get through by itself.
    const b = blockedBy(res);
    if (!b.blocked) {
      this.cache?.set(hash, {
        endpoint: url,
        payload: {},
        fetchedAt: startedAt,
        costUsd: 0,
        result: res,
      });
    }
    return { res, ...b };
  }
}

function blockedBy(res: Fetched): { blocked?: string } {
  if (res.status === 403 || res.status === 429 || res.status === 503) {
    return {
      blocked: BOT_CHECK.test(res.text) ? `bot check (HTTP ${res.status})` : `HTTP ${res.status}`,
    };
  }
  if (
    res.status < 400 &&
    BOT_CHECK.test(res.text.slice(0, 5000)) &&
    !/<urlset|<sitemapindex/i.test(res.text)
  ) {
    return { blocked: "bot check" };
  }
  return {};
}
