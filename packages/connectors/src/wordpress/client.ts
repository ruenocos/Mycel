import type { MenuGroup, SitePage, SitePages, SiteSection } from "@mycel/schema";
import { FileCache, requestHash } from "../dataforseo/cache.ts";
import { withUserAgent } from "../http.ts";
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
  /** Plural label in the site's language ("Oplossingen", "Berichten"). */
  name?: string;
  rest_base?: string;
  rest_namespace?: string;
}

/**
 * The category taxonomy per post type: posts use "categories", WooCommerce products
 * "product_cat". A product's category says which shop category page it supports (issue #42).
 */
const CATEGORY_TAXONOMY: Record<string, string> = { post: "categories", product: "product_cat" };

interface WpItem {
  id: number;
  type: string;
  slug: string;
  link: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
  excerpt?: { rendered?: string };
  categories?: number[];
  /** WooCommerce product categories. */
  product_cat?: number[];
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

/** The folder a page sits in: "/a/b/" → "/a/", "/a/" → "/". */
export function folderOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? `/${parts.slice(0, -1).join("/")}/` : "/";
}

/** The deepest folder all paths share ("/kennisbank/ai/x/", "/kennisbank/bc/y/" → "/kennisbank/"). */
export function commonFolder(paths: string[]): string {
  const folders = paths.map((p) => folderOf(p).split("/").filter(Boolean));
  const [first = []] = folders;
  let n = 0;
  while (n < first.length && folders.every((f) => f[n] === first[n])) n++;
  return n ? `/${first.slice(0, n).join("/")}/` : "/";
}

/**
 * Main-menu groups from a page's HTML: each menu item with a sub-menu (WordPress and Elementor
 * mark them "menu-item-has-children") gives its label and the same-site paths under it. A menu
 * printed twice (desktop and mobile) gives each group once.
 */
export function readMenu(html: string, base: string): MenuGroup[] {
  const origin = new URL(base).origin;
  const groups = new Map<string, Set<string>>();
  const open = /<li\b[^>]*class="[^"]*\bmenu-item-has-children\b[^"]*"[^>]*>/gi;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const rest = html.slice(m.index + m[0].length);
    const label = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(rest);
    const sub = /<ul\b[^>]*class="[^"]*\bsub-menu\b[^"]*"[^>]*>/i.exec(rest);
    if (!label?.[1] || !sub) continue;
    // The sub-menu runs to its own closing tag; nested lists count.
    let depth = 1;
    let end = sub.index + sub[0].length;
    const tag = /<(\/?)ul\b[^>]*>/gi;
    tag.lastIndex = end;
    for (let t = tag.exec(rest); t && depth > 0; t = tag.exec(rest)) {
      depth += t[1] ? -1 : 1;
      end = t.index;
    }
    const name = htmlToText(label[1]);
    if (!name) continue;
    const urls = groups.get(name) ?? new Set<string>();
    for (const h of rest.slice(sub.index, end).matchAll(/href="([^"#]+)"/gi)) {
      const href = decodeEntities(h[1] as string);
      if (!URL.canParse(href, origin)) continue;
      const u = new URL(href, origin);
      if (u.origin === origin && u.pathname !== "/")
        urls.add(u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`);
    }
    if (urls.size) groups.set(name, urls);
  }
  return [...groups].map(([label, urls]) => ({ label, urls: [...urls] }));
}

/** Generic kind from structure only (no client words): root is home, posts are blog. */
export function kindOf(type: string, path: string): SitePage["kind"] {
  if (path === "/") return "home";
  if (type === "post") return "blog";
  return "other";
}

/** A post type slug as a section key: lowercase letters, digits and hyphens. */
const sectionKey = (slug: string) =>
  slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "section";

export class WordPressClient {
  private readonly base: string;
  private readonly cache: FileCache | null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WordPressOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.cache = opts.cacheDir ? new FileCache(opts.cacheDir) : null;
    this.fetchImpl = withUserAgent(opts.fetchImpl ?? fetch);
  }

  /** Language and region from the home page's <html lang>, e.g. "nl-NL" → nl / NL. */
  async siteLanguage(rec: CallRecorder): Promise<{ language: string; country?: string } | null> {
    const { body } = await this.get(`${this.base}/`, rec, "text");
    const m = /<html[^>]*\blang="([a-z]{2})(?:[-_]([a-z]{2}))?"/i.exec(String(body));
    if (!m?.[1]) return null;
    return { language: m[1].toLowerCase(), ...(m[2] ? { country: m[2].toUpperCase() } : {}) };
  }

  /**
   * All indexable content of the site as SitePages. Noindex pages are skipped. Every page keeps
   * its post type as its section (issue #51), posts and products their first category, and the home page's
   * menu groups come along for sections that have no folder.
   */
  async readSite(rec: CallRecorder): Promise<SitePages> {
    const types = await this.contentTypes(rec);
    const categoriesOf = new Map<string, Map<number, string>>();
    for (const t of types) {
      const tax = CATEGORY_TAXONOMY[t.slug];
      if (!tax) continue;
      try {
        categoriesOf.set(t.slug, await this.categories(tax, rec));
      } catch (err) {
        rec.log.warn("wordpress: categories not read", {
          type: t.slug,
          taxonomy: tax,
          error: (err as Error).message,
        });
      }
    }
    const pages: SitePage[] = [];
    const sections: SiteSection[] = [];
    const seen = new Set<string>();
    for (const t of types) {
      const own: SitePage[] = [];
      for (const item of await this.items(t, rec)) {
        if (item.yoast_head_json?.robots?.index === "noindex") continue;
        const page = this.toPage(item);
        if (!page || seen.has(page.url)) continue;
        seen.add(page.url);
        const tax = CATEGORY_TAXONOMY[t.slug];
        const ids = tax === "product_cat" ? item.product_cat : item.categories;
        const category = categoriesOf.get(t.slug)?.get(ids?.[0] ?? -1);
        own.push({ ...page, section: sectionKey(t.slug), ...(category ? { category } : {}) });
      }
      if (!own.length) continue;
      pages.push(...own);
      const folder = commonFolder(own.map((p) => p.url));
      const byCategory = new Map<string, string[]>();
      for (const p of own)
        if (p.category) byCategory.set(p.category, [...(byCategory.get(p.category) ?? []), p.url]);
      // A section with its own folder goes by the folder's words, which visitors see in the URL
      // and the menu ("Kennisbank"), not the post type's admin label ("Berichten").
      const seg = folder.split("/").filter(Boolean)[0];
      const label = decodeEntities(t.name ?? "").trim() || t.slug;
      sections.push({
        key: sectionKey(t.slug),
        name: seg ? seg.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()) : label,
        folder,
        source: "post_type",
        categories: [...byCategory].map(([name, urls]) => {
          const f = commonFolder(urls);
          return { name, ...(f.length > folder.length ? { folder: f } : {}) };
        }),
      });
    }
    let menu: MenuGroup[] = [];
    try {
      const { body } = await this.get(`${this.base}/`, rec, "text");
      menu = readMenu(String(body), this.base);
    } catch (err) {
      rec.log.warn("wordpress: home page menu not read", { error: (err as Error).message });
    }
    rec.log.debug("wordpress site read", {
      types: types.map((t) => t.slug),
      pages: pages.length,
      sections: sections.map((s) => `${s.key} ${s.folder}`),
      menuGroups: menu.map((g) => `${g.label} (${g.urls.length})`),
    });
    return { site: this.base, source: "wordpress", pages, sections, menu };
  }

  /** Category terms by id, in the site's words (post categories or WooCommerce product_cat). */
  private async categories(taxonomy: string, rec: CallRecorder): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    for (let page = 1; page <= 10; page++) {
      const url = `${this.base}/wp-json/wp/v2/${taxonomy}?per_page=100&page=${page}&_fields=id,name`;
      const { body, totalPages } = await this.get(url, rec, "json");
      if (!Array.isArray(body)) break;
      for (const c of body as { id: number; name?: string }[])
        if (c.name) out.set(c.id, decodeEntities(c.name).trim());
      if (page >= (totalPages ?? 1) || body.length === 0) break;
    }
    return out;
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
    const fields = "id,type,slug,link,title,content,excerpt,categories,product_cat,yoast_head_json";
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
