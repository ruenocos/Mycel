import type { ClientContext, SitePage } from "@mycel/schema";
import { brandTokens } from "../research/seeds.ts";
import { type MapPlan, type NodeDraft, tokens } from "./plan.ts";
import { FORMAT_KINDS, HUB_KINDS, SKIP_KINDS } from "./rules.ts";
import { slugify } from "./urls.ts";

/**
 * The client's existing site in the map (Koray step 15): which existing page serves which map
 * page, which pages are sections of the site (locked hubs), and the word scores the model gets as
 * hints. Data only; the model's reading of pages is in link.ts.
 */

/** What page linking needs from an existing page; research.json keeps exactly these fields. */
export type PageRef = Pick<SitePage, "url" | "kind" | "title" | "h1">;

export const isHome = (p: PageRef) => p.kind === "home" || p.url === "/";

/** Existing pages that can sit on a map page: everything but home, about and contact. */
export const linkablePages = (pages: PageRef[]) =>
  pages.filter((p) => !isHome(p) && !SKIP_KINDS.has(p.kind));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A page's own name: its H1 (else title) without the site's name and separators. */
export function pageTitle(page: PageRef, siteName: string): string {
  const name = new RegExp(escapeRe(siteName), "gi");
  const clean = (t: string) =>
    t
      .replace(name, "")
      .replace(/^[\s|–—:-]+|[\s|–—:-]+$/g, "")
      .trim();
  return clean(page.h1) || clean(page.title);
}

const folderOf = (url: string) => {
  const parts = url.split("/").filter(Boolean);
  return parts.length === 2 ? parts[0] : undefined;
};

/**
 * A section page: a service, category or location page; or, when a reader can't tell kinds
 * (WordPress custom post types come in as "other"), a page one level down in a folder of 3+
 * such pages that holds no articles or products, like /sectoren/bouw/ or /diensten/advies/.
 */
export function isSectionPage(page: PageRef, all: PageRef[]): boolean {
  if (HUB_KINDS.has(page.kind)) return true;
  if (page.kind !== "other") return false;
  const folder = folderOf(page.url);
  if (!folder) return false;
  const inFolder = all.filter((p) => p.url.split("/").filter(Boolean)[0] === folder);
  return (
    inFolder.filter((p) => folderOf(p.url) === folder && p.kind === "other").length >= 3 &&
    !inFolder.some((p) => FORMAT_KINDS.has(p.kind))
  );
}

/**
 * Grab the existing structure: a node that an existing section page (isSectionPage) serves
 * becomes a site hub, locked under the root at that page's URL. A section page that serves no
 * map page (a sector nobody searches for by name yet) still is a section of the business: it
 * gets a hub of its own, without search demand, so pages can hang under it. A word-rule parent
 * only stays when it is a site hub too (category > subcategory). Pages the model didn't judge
 * fall back to the word score.
 *
 * Returns the hubs per entity, and the page links with the new hubs' pages added.
 */
export function anchorSiteHubs(
  plan: MapPlan,
  pages: PageRef[],
  pageLinks: Map<string, string | null> = new Map(),
): { hubs: Map<string, string[]>; links: Map<string, string | null> } {
  const hubs = new Map<string, string[]>();
  const links = new Map(pageLinks);
  const ctx = plan.context;
  const hubPages = pages.filter((p) => !isHome(p) && isSectionPage(p, pages));
  const served = new Set<string>();
  for (const { entity, nodes } of plan.entities) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const words = new Map<string, string>();
    for (const [id, urls] of matchPages(nodes, hubPages, ctx)) {
      for (const url of urls) words.set(url, id);
    }
    const ids: string[] = [];
    for (const page of hubPages) {
      const id = pageLinks.has(page.url) ? pageLinks.get(page.url) : words.get(page.url);
      const n = id ? byId.get(id) : undefined;
      if (!n || n.isRoot) continue;
      served.add(page.url);
      if (n.hub) continue;
      n.hub = "site";
      ids.push(n.id);
    }
    for (const id of ids) {
      const n = byId.get(id) as NodeDraft;
      if (n.parentId && !byId.get(n.parentId)?.hub) delete n.parentId;
    }
    hubs.set(entity, ids);
  }
  // Section pages no map page covers: a hub of their own in the first map.
  const first = plan.entities[0];
  if (first) {
    const ids = hubs.get(first.entity) ?? [];
    const taken = new Set(first.nodes.map((n) => n.id));
    for (const page of hubPages) {
      if (served.has(page.url)) continue;
      const title = pageTitle(page, ctx.site.name);
      // A question ("Staat jouw sector er niet bij?") is a catch-all page, not a section.
      if (!title || title.endsWith("?")) continue;
      let id = `site-${slugify(page.url)}`;
      for (let i = 2; taken.has(id); i++) id = `site-${slugify(page.url)}-${i}`;
      taken.add(id);
      first.nodes.push(siteHubNode(id, first.entity, title, ctx));
      links.set(page.url, id);
      ids.push(id);
    }
    hubs.set(first.entity, ids);
  }
  return { hubs, links };
}

function siteHubNode(id: string, entity: string, title: string, ctx: ClientContext): NodeDraft {
  return {
    id,
    entity,
    isRoot: false,
    section: "core",
    mainQuery: title.toLowerCase(),
    queries: [],
    sections: [],
    volume: 0,
    gscImpressions: 0,
    intent: { main: ctx.market.city ? "local" : "commercial", mixed: false, source: "tier" },
    aiOverview: null,
    hub: "site",
    name: title,
    qdpWhy:
      "A section your site already has. Nobody searches for it by this name yet, so it stays as a hub for related pages.",
  };
}

export interface PageScore {
  /** Weighted share of the query's words found on the page (title, H1, URL). */
  score: number;
  /** Weighted share of the page's H1 words that the query covers: the page's own topic. */
  h1: number;
}

/**
 * Scores every existing page against every node. Words are weighted by rarity across the map's
 * queries, so "dakdekker" in "Dakdekker Schiedam" doesn't make the Schiedam page the dakdekker
 * page. The site's own name is taken out first: it sits in every title.
 */
export function scorePages(
  nodes: NodeDraft[],
  pages: PageRef[],
  ctx: Pick<ClientContext, "site" | "market">,
): Map<string, Map<string, PageScore>> {
  const language = ctx.market.language;
  const brands = new Set(brandTokens(ctx));
  const nameRe = new RegExp(escapeRe(ctx.site.name), "gi");
  const clean = (text: string) => {
    const t = tokens(text.replace(nameRe, " "), language);
    for (const b of brands) t.delete(b);
    return t;
  };
  const queryTokens = new Map(
    nodes.map((n) => [n.id, [n.mainQuery, ...n.queries].map((q) => tokens(q, language))]),
  );
  const df = new Map<string, number>();
  let docs = 0;
  for (const list of queryTokens.values()) {
    for (const t of list) {
      docs++;
      for (const x of t) df.set(x, (df.get(x) ?? 0) + 1);
    }
  }
  const w = (x: string) => Math.log((docs + 1) / ((df.get(x) ?? 0) + 1)) + 0.1;
  const sum = (xs: Iterable<string>) => {
    let total = 0;
    for (const x of xs) total += w(x);
    return total;
  };
  const out = new Map<string, Map<string, PageScore>>();
  for (const page of pages) {
    if (isHome(page) || SKIP_KINDS.has(page.kind)) continue;
    const words = clean(`${page.title} ${page.h1} ${page.url.replace(/[/-]/g, " ")}`);
    const h1 = clean(page.h1);
    const h1Weight = sum(h1);
    const perNode = new Map<string, PageScore>();
    for (const n of nodes) {
      let best: PageScore = { score: 0, h1: 0 };
      for (const t of queryTokens.get(n.id) ?? []) {
        if (t.size === 0) continue;
        const score = sum([...t].filter((x) => words.has(x))) / sum(t);
        const h1Cover = h1Weight ? sum([...h1].filter((x) => t.has(x))) / h1Weight : 0;
        if (score > best.score || (score === best.score && h1Cover > best.h1)) {
          best = { score, h1: h1Cover };
        }
      }
      if (best.score > 0) perNode.set(n.id, best);
    }
    out.set(page.url, perNode);
  }
  return out;
}

/** A page is a match for a node when it covers the query and the query covers its H1. */
export const isWordMatch = (s: PageScore | undefined) => !!s && s.score >= 2 / 3 && s.h1 >= 0.5;

/** Word-only page linking, when no model labels are given: each page to its best node. */
export function matchPages(
  nodes: NodeDraft[],
  pages: PageRef[],
  ctx: Pick<ClientContext, "site" | "market">,
  scores = scorePages(nodes, pages, ctx),
): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (id: string, url: string) => found.set(id, [...(found.get(id) ?? []), url]);
  const root = nodes.find((n) => n.isRoot);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const page of pages) {
    if (isHome(page)) {
      if (root) add(root.id, page.url);
      continue;
    }
    let best: { id: string; s: PageScore } | undefined;
    for (const [id, s] of scores.get(page.url) ?? []) {
      if (!isWordMatch(s)) continue;
      const better =
        !best ||
        s.score + s.h1 > best.s.score + best.s.h1 ||
        (s.score + s.h1 === best.s.score + best.s.h1 &&
          (byId.get(id)?.volume ?? 0) > (byId.get(best.id)?.volume ?? 0));
      if (better) best = { id, s };
    }
    if (best) add(best.id, page.url);
  }
  return found;
}

/** Candidate pages for one node, for the model to confirm: the best word scores first. */
export function pageCandidates(
  scores: Map<string, Map<string, PageScore>>,
  nodeId: string,
  max = 3,
): string[] {
  return [...scores.entries()]
    .map(([url, per]) => ({ url, s: per.get(nodeId) }))
    .filter((x): x is { url: string; s: PageScore } => !!x.s && x.s.score >= 0.5 && x.s.h1 > 0)
    .sort((a, b) => b.s.score + b.s.h1 - (a.s.score + a.s.h1))
    .slice(0, max)
    .map((x) => x.url);
}
