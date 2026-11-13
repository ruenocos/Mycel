import type { SitePage, SitePages } from "@mycel/schema";
import { FileCache, requestHash } from "../dataforseo/cache.ts";
import type { CallRecorder } from "../recorder.ts";

/**
 * Read-only WordPress reader over the public REST API (issue #15). Turns pages, posts and
 * public custom post types into the same SitePages shape the test-client fixtures use.
 * No login, no writes: the pilot only reads the public API (ADR 0011).
 */

const SERVICE = "wordpress";
/** Post types that hold no readable content: media, menus, templates and page-builder parts. */
const NON_CONTENT_TYPE = /^(attachment|nav_menu_item|wp_.*|elementor_.*|e-.*)$/;

export interface WordPressOptions {
  /** Site root, e.g. "https://desaak.com". */
  baseUrl: string;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  /** Characters of body text kept per page. */
  textChars?: number;
  /** Safety cap per post type. */
  maxPerType?: number;
}

export class WordPressError extends Error {
  override name = "WordPressError";
  constructor(
    message: string,
    readonly status: number | "error",
  ) {
    super(message);
  }
}

interface WpType {
  slug: string;
  rest_base?: string;
  rest_namespace?: string;
}

interface WpItem {
  id: number;
  type: string;
  slug: string;
  link: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
  excerpt?: { rendered?: string };
  yoast_head_json?: {
    title?: string;
    description?: string;
    og_description?: string;
    robots?: { index?: string };
  };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Visible text of an HTML fragment: scripts, styles and tags removed, whitespace collapsed. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped)
    .replace(/[ \t\f\r]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function firstH1(html: string): string | undefined {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const text = m?.[1] ? htmlToText(m[1]) : "";
  return text || undefined;
}

/** Generic kind from structure only (no client words): root is home, posts are blog. */
export function kindOf(type: string, path: string): SitePage["kind"] {
  if (path === "/") return "home";
  if (type === "post") return "blog";
  return "other";
}

export class WordPressClient {
  private readonly base: string;
  private readonly cache: FileCache | null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WordPressOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.cache = opts.cacheDir ? new FileCache(opts.cacheDir) : null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Language and region from the home page's <html lang>, e.g. "nl-NL" → nl / NL. */
  async siteLanguage(rec: CallRecorder): Promise<{ language: string; country?: string } | null> {
    const { body } = await this.get(`${this.base}/`, rec, "text");
    const m = /<html[^>]*\blang="([a-z]{2})(?:[-_]([a-z]{2}))?"/i.exec(String(body));
    if (!m?.[1]) return null;
    return { language: m[1].toLowerCase(), ...(m[2] ? { country: m[2].toUpperCase() } : {}) };
  }

  /** All indexable content of the site as SitePages. Noindex pages are skipped. */
  async readSite(rec: CallRecorder): Promise<SitePages> {
    const types = await this.contentTypes(rec);
    const pages: SitePage[] = [];
    const seen = new Set<string>();
    for (const t of types) {
      for (const item of await this.items(t, rec)) {
        if (item.yoast_head_json?.robots?.index === "noindex") continue;
        const page = this.toPage(item);
        if (!page || seen.has(page.url)) continue;
        seen.add(page.url);
        pages.push(page);
      }
    }
    rec.log.debug("wordpress site read", { types: types.map((t) => t.slug), pages: pages.length });
    return { site: this.base, source: "wordpress", pages };
  }

  private async contentTypes(rec: CallRecorder): Promise<WpType[]> {
    const { body } = await this.get(`${this.base}/wp-json/wp/v2/types`, rec, "json");
    const all = Object.values((body ?? {}) as Record<string, WpType>);
    return all.filter(
      (t) =>
        !NON_CONTENT_TYPE.test(t.slug) &&
        typeof t.rest_base === "string" &&
        !t.rest_base.includes("(") &&
        (t.rest_namespace ?? "wp/v2") === "wp/v2",
    );
  }

  private async items(type: WpType, rec: CallRecorder): Promise<WpItem[]> {
    const fields = "id,type,slug,link,title,content,excerpt,yoast_head_json";
    const out: WpItem[] = [];
    const max = this.opts.maxPerType ?? 500;
    for (let page = 1; out.length < max; page++) {
      const url = `${this.base}/wp-json/wp/v2/${type.rest_base}?per_page=100&page=${page}&_fields=${fields}`;
      const { body, totalPages } = await this.get(url, rec, "json");
      if (!Array.isArray(body)) break;
      out.push(...(body as WpItem[]));
      if (page >= (totalPages ?? 1) || body.length === 0) break;
    }
    return out.slice(0, max);
  }

  private toPage(item: WpItem): SitePage | null {
    let path: string;
    try {
      const u = new URL(item.link);
      if (u.origin !== new URL(this.base).origin) return null;
      path = u.pathname || "/";
    } catch {
      return null;
    }
    const html = item.content?.rendered ?? "";
    const wpTitle = htmlToText(item.title?.rendered ?? "");
    const title = decodeEntities(item.yoast_head_json?.title ?? "").trim() || wpTitle;
    const h1 = firstH1(html) ?? wpTitle;
    const body = htmlToText(html) || htmlToText(item.excerpt?.rendered ?? "");
    const text = body.slice(0, this.opts.textChars ?? 800).trim();
    if (!title || !h1 || !text) return null;
    const meta = decodeEntities(
      item.yoast_head_json?.description ?? item.yoast_head_json?.og_description ?? "",
    ).trim();
    return {
      url: path,
      kind: kindOf(item.type, path),
      title,
      h1,
      ...(meta ? { metaDescription: meta } : {}),
      text,
    };
  }

  /** One GET, cached by URL when a cache dir is set, always logged (ADR 0009). */
  private async get(
    url: string,
    rec: CallRecorder,
    as: "json" | "text",
  ): Promise<{ body: unknown; totalPages?: number }> {
    const hash = requestHash(`${SERVICE}:${url}`, {});
    const endpoint = new URL(url).pathname;
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const cached = this.cache?.get<{ body: unknown; totalPages?: number }>(hash)?.result;
    if (cached) {
      rec.recordApiCall({
        service: SERVICE,
        endpoint,
        requestHash: hash,
        cache: "hit",
        costUsd: 0,
        latencyMs: 0,
        status: 200,
        startedAt,
      });
      return cached;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Accept: as === "json" ? "application/json" : "text/html" },
      });
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
      throw new WordPressError(`GET ${url} failed: ${e.message}`, "error");
    }
    const text = await res.text();
    rec.recordApiCall({
      service: SERVICE,
      endpoint,
      requestHash: hash,
      cache: this.cache ? "miss" : "bypass",
      costUsd: 0,
      latencyMs: Date.now() - t0,
      status: res.status,
      ...(res.ok ? {} : { error: { name: "HttpError", message: text.slice(0, 300) } }),
      startedAt,
    });
    // WordPress answers 400 when a page number runs past the end; treat that as "no more".
    if (res.status === 400 && /rest_post_invalid_page_number/.test(text)) return { body: [] };
    if (!res.ok) throw new WordPressError(`GET ${url}: HTTP ${res.status}`, res.status);
    let body: unknown = text;
    if (as === "json") {
      try {
        body = JSON.parse(text);
      } catch (err) {
        throw new WordPressError(
          `GET ${url}: invalid JSON (${(err as Error).message})`,
          res.status,
        );
      }
    }
    const tp = Number(res.headers.get("x-wp-totalpages"));
    const value = { body, ...(Number.isFinite(tp) && tp > 0 ? { totalPages: tp } : {}) };
    this.cache?.set(hash, {
      endpoint: url,
      payload: {},
      fetchedAt: startedAt,
      costUsd: 0,
      result: value,
    });
    return value;
  }
}
