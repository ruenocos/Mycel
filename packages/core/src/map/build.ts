import type {
  ClientContext,
  ClusterDetail,
  ClusterSet,
  FilteredQuery,
  LinkOut,
  MapNode,
  MapSection,
  PageIntent,
  SiteMaps,
  SitePage,
  TopicalMap,
} from "@mycel/schema";
import { termSimilarity, termWeights, variantKey } from "../cluster/cluster.ts";
import { brandTokens, isBrandQuery } from "../research/seeds.ts";

/**
 * Koray steps 11-14 and 20 (issue #19), the deterministic half: page clusters become map nodes
 * under a root per central entity. Data decides the structure; the model only names what data
 * can't (a hub for pages whose words don't nest, the raw-node attribute, macro context, why).
 *
 * - Hierarchy: a page whose words contain another page's words sits under it ("plat dak
 *   vervangen" under "dak vervangen"). Pages with no such parent get one from the model, chosen
 *   among the top-level pages, or stay under the root.
 * - Intent per page: query intents weighted by volume, plus what the results page shows. A
 *   navigational label only stands when a query names a brand; a core page that names one of
 *   the client's offerings is a service page, not an article.
 * - Brand searches ("de saak") are the homepage: they fold into the root.
 * - Priority 1-5: tier x intent x demand, banded by rank.
 * - Quality nodes (step 13): the strongest core pages, linked from the homepage.
 * - Existing pages: the model links them to nodes (it reads meaning: "XL planten" are big
 *   plants), from candidates scored on weighted title, H1 and URL words; without the model the
 *   word score decides. Two existing pages on one node = cannibalisation conflict.
 * - Link plan (step 20): up to the core, hub to pages, siblings, 3 side bridges between hubs.
 */

export type Intent = PageIntent["main"];

export interface NodeDraft {
  id: string;
  entity: string;
  isRoot: boolean;
  section: "core" | "outer";
  clusterId?: string;
  mainQuery: string;
  queries: string[];
  sections: MapSection[];
  volume: number;
  gscImpressions: number;
  cpc?: number;
  intent: PageIntent;
  aiOverview: { present: boolean; cited: boolean } | null;
  /** Parent from the word rule; undefined = top level (model may pick a hub). */
  parentId?: string;
  /** An existing service, category or location page sits on it: a locked hub (anchorSiteHubs). */
  hub?: "site";
  qdpWhy: string;
}

export interface NodeLabel {
  attribute?: string;
  macroContext?: string;
  why?: string;
  /** Model's hub choice for a top-level page: a node id, or "root". */
  parent?: string;
  /** Existing page URLs the model linked to this node. Undefined: the model wasn't asked. */
  pages?: string[];
}

/** What page linking needs from an existing page; research.json keeps exactly these fields. */
export type PageRef = Pick<SitePage, "url" | "kind" | "title" | "h1">;

export interface MapPlan {
  context: ClientContext;
  /** Per entity name: its drafts, root first. */
  entities: { entity: string; nodes: NodeDraft[] }[];
}

const tokens = (text: string, language: string) =>
  new Set(variantKey(text, language).split(" ").filter(Boolean));

const strictSubset = (a: Set<string>, b: Set<string>) =>
  a.size > 0 && a.size < b.size && [...a].every((t) => b.has(t));

/** ASCII slug for proposed URLs: diacritics stripped, words joined by hyphens. */
export function slugify(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "page"
  );
}

const INTENTS: Intent[] = ["informational", "commercial", "transactional", "navigational", "local"];

/**
 * Votes from what the results page shows. Shopping and local results mean people want to buy or
 * visit; answer boxes and questions mean they want to know.
 */
const FEATURE_INTENT: Record<string, Intent> = {
  popular_products: "transactional",
  shopping: "transactional",
  paid: "commercial",
  local_pack: "local",
  map: "local",
  featured_snippet: "informational",
  answer_box: "informational",
  people_also_ask: "informational",
  knowledge_graph: "informational",
  video: "informational",
};

export interface IntentHints {
  /** A query names the client's or a competitor's brand: navigational can stand. */
  brand?: boolean;
  /** The page names one of the client's offerings (core pages only): a service page. */
  offering?: boolean;
  /** The market is one city: searches for a place are local, not navigational. */
  local?: boolean;
}

/**
 * Intent of a page: member intents weighted by volume, results-page features, then the tier.
 * Data providers call product and place searches navigational ("business central partner",
 * "fysiotherapeut utrecht"); without a brand in the query that becomes local in a city market
 * and is dropped elsewhere.
 */
export function pageIntent(
  members: { intent?: string | undefined; volume: number }[],
  features: string[],
  tier: "core" | "outer",
  hints: IntentHints = {},
): PageIntent {
  const score = new Map<Intent, number>();
  let total = 0;
  for (const m of members) {
    if (!m.intent || !INTENTS.includes(m.intent as Intent)) continue;
    let intent = m.intent as Intent;
    if (intent === "navigational" && !hints.brand) {
      if (!hints.local) continue;
      intent = "local";
    }
    const w = Math.max(1, m.volume);
    score.set(intent, (score.get(intent) ?? 0) + w);
    total += w;
  }
  const featureWeight = Math.max(1, total) * 0.3;
  for (const f of features) {
    const i = FEATURE_INTENT[f];
    if (i) score.set(i, (score.get(i) ?? 0) + featureWeight);
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  const [first, second] = ranked;
  const service: Intent = hints.local ? "local" : "commercial";
  if (hints.offering && (!first || first[0] === "informational")) {
    // People read about the service before they book it: the page sells, and answers too.
    return { main: service, mixed: !!first, source: "offering" };
  }
  if (!first) {
    return { main: tier === "core" ? service : "informational", mixed: false, source: "tier" };
  }
  return { main: first[0], mixed: !!second && second[1] >= first[1] * 0.6, source: "data" };
}

const TIER_WEIGHT = { core: 1, outer: 0.6 } as const;
const INTENT_WEIGHT: Record<Intent, number> = {
  transactional: 1,
  commercial: 1,
  local: 1,
  informational: 0.7,
  navigational: 0.4,
};

/** Step 1: page clusters become node drafts per central entity, each with its word-rule parent. */
export function planMaps(input: {
  context: ClientContext;
  clusters: ClusterSet;
  queries?: FilteredQuery[];
}): MapPlan {
  const { context, clusters } = input;
  const language = context.market.language;
  const byQuery = new Map((input.queries ?? []).map((q) => [q.normalized, q]));
  const entityNames = context.centralEntities.map((e) => e.name);
  const entityOf = (c: ClusterDetail) =>
    c.entity && entityNames.includes(c.entity) ? c.entity : (entityNames[0] as string);
  const isOwnBrand = ownBrand(context);
  const anyBrands = [
    ...brandTokens(context),
    ...context.competitors.flatMap((c) => {
      try {
        const url = /^https?:\/\//.test(c) ? c : `https://${c}`;
        return brandTokens({ site: { url, name: new URL(url).hostname } });
      } catch {
        // A competitor written as a name, not a domain: its words are the brand.
        return [c];
      }
    }),
  ];
  const offerings = context.offerings.map((o) => tokens(o, language)).filter((t) => t.size > 0);

  const sectionsOf = new Map<string, MapSection[]>();
  for (const c of clusters.clusters) {
    if (c.qdp === "page" || !c.hostClusterId) continue;
    const list = sectionsOf.get(c.hostClusterId) ?? [];
    list.push({
      clusterId: c.id,
      mainQuery: c.mainQuery,
      qdp: c.qdp,
      queries: c.members.map((m) => m.query),
      volume: c.demand.volume,
    });
    sectionsOf.set(c.hostClusterId, list);
  }

  const entities: MapPlan["entities"] = [];
  for (const entity of entityNames) {
    const pages = clusters.clusters.filter(
      (c) => c.qdp === "page" && c.label !== "bridge" && entityOf(c) === entity,
    );
    const entityTokens = tokens(entity, language);
    const draft = (c: ClusterDetail): NodeDraft => {
      const members = c.members.map((m) => {
        const q = byQuery.get(m.query);
        return { intent: q?.intent, volume: m.volume ?? 0, cpc: q?.metrics.cpc };
      });
      const priced = members.filter((m) => m.cpc !== undefined && m.volume > 0);
      const pricedVolume = priced.reduce((s, m) => s + m.volume, 0);
      const section = c.label === "core" ? "core" : "outer";
      const texts = [c.mainQuery, ...c.members.map((m) => m.query)];
      const hints: IntentHints = {
        brand: texts.some((t) => isOwnBrand(t) || isBrandQuery(t, anyBrands)),
        offering:
          section === "core" &&
          texts.some((t) => {
            const mine = tokens(t, language);
            return offerings.some((o) => [...o].every((x) => mine.has(x)));
          }),
        local: !!context.market.city,
      };
      return {
        id: `n-${c.id}`,
        entity,
        isRoot: false,
        section,
        clusterId: c.id,
        mainQuery: c.mainQuery,
        queries: c.members.map((m) => m.query),
        sections: (sectionsOf.get(c.id) ?? []).sort((a, b) => b.volume - a.volume),
        volume: c.demand.volume,
        gscImpressions: c.demand.gscImpressions,
        ...(pricedVolume > 0
          ? {
              cpc:
                Math.round(
                  (priced.reduce((s, m) => s + (m.cpc ?? 0) * m.volume, 0) / pricedVolume) * 100,
                ) / 100,
            }
          : {}),
        intent: pageIntent(members, c.serpFeatures, section, hints),
        aiOverview: c.aiOverview,
        qdpWhy: c.qdpWhy,
      };
    };
    const nodes = pages.map(draft);

    // The root: the page that is just the entity's name ("dakwerk"), else a new page for it.
    const plain = nodes
      .filter((n) => {
        const t = tokens(n.mainQuery, language);
        return t.size > 0 && [...t].every((x) => entityTokens.has(x));
      })
      .sort((a, b) => b.volume - a.volume)[0];
    let root: NodeDraft;
    if (plain) {
      root = plain;
      root.isRoot = true;
      root.section = "core";
      root.id = `root-${slugify(entity)}`;
    } else {
      root = {
        id: `root-${slugify(entity)}`,
        entity,
        isRoot: true,
        section: "core",
        mainQuery: entity,
        queries: [],
        sections: [],
        volume: 0,
        gscImpressions: 0,
        intent: { main: "commercial", mixed: false, source: "tier" },
        aiOverview: null,
        qdpWhy: "Root of the map: the central entity itself.",
      };
      nodes.unshift(root);
    }

    // Brand searches are the homepage: their queries and demand go to the root.
    for (const n of [...nodes]) {
      if (n === root || !isOwnBrand(n.mainQuery)) continue;
      root.queries.push(n.mainQuery, ...n.queries.filter((q) => q !== n.mainQuery));
      root.sections.push(...n.sections);
      root.volume += n.volume;
      root.gscImpressions += n.gscImpressions;
      nodes.splice(nodes.indexOf(n), 1);
    }

    // Pages with the same words ("popeye arm", "popeyes arm") are one page: the smaller folds in.
    const byKey = new Map<string, NodeDraft>();
    for (const n of [...nodes].sort((a, b) => b.volume - a.volume)) {
      if (n.isRoot) continue;
      const key = variantKey(n.mainQuery, language);
      const keep = byKey.get(key);
      if (!keep) {
        byKey.set(key, n);
        continue;
      }
      if (keep.section === "outer" && n.section === "core") keep.section = "core";
      keep.queries.push(...n.queries.filter((q) => !keep.queries.includes(q)));
      keep.sections.push(...n.sections);
      keep.volume += n.volume;
      keep.gscImpressions += n.gscImpressions;
      nodes.splice(nodes.indexOf(n), 1);
    }

    // Word rule: the most specific page whose words are all in this page's words is its parent.
    // A core page never sits under an outer page.
    const tok = new Map(nodes.map((n) => [n.id, tokens(n.mainQuery, language)]));
    for (const n of nodes) {
      if (n.isRoot) continue;
      const mine = tok.get(n.id) as Set<string>;
      let best: NodeDraft | undefined;
      for (const p of nodes) {
        if (p === n || p.isRoot) continue;
        if (n.section === "core" && p.section === "outer") continue;
        const theirs = tok.get(p.id) as Set<string>;
        if (!strictSubset(theirs, mine)) continue;
        const better =
          !best ||
          theirs.size > (tok.get(best.id) as Set<string>).size ||
          (theirs.size === (tok.get(best.id) as Set<string>).size && p.volume > best.volume);
        if (better) best = p;
      }
      if (best) n.parentId = best.id;
    }
    entities.push({ entity, nodes: [root, ...nodes.filter((n) => n !== root)] });
  }
  return { context, entities };
}

/**
 * Top-level pages that may receive a model-chosen hub, and the hubs they may pick from. Site hubs
 * are locked under the root: they are offered as hubs but never moved.
 */
export function hubChoices(plan: MapPlan, entity: string) {
  const nodes = plan.entities.find((e) => e.entity === entity)?.nodes ?? [];
  const top = nodes.filter((n) => !n.isRoot && !n.parentId);
  return { pages: top.filter((n) => !n.hub), hubs: top };
}

/** Page kinds that are a section of the site: what the business offers, sells or where. */
const HUB_KINDS = new Set<SitePage["kind"]>(["service", "category", "location"]);
/** Kinds that mark a folder as a format (articles, products), not a topic. */
const FORMAT_KINDS = new Set<SitePage["kind"]>(["blog", "guide", "product"]);
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
 * becomes a site hub, locked under the root at that page's URL. A word-rule parent only stays
 * when it is a site hub too (category > subcategory). Pages the model didn't judge fall back to
 * the word score. Returns the hubs found per entity.
 */
export function anchorSiteHubs(
  plan: MapPlan,
  pages: PageRef[],
  pageLinks?: Map<string, string | null>,
): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const hubPages = pages.filter((p) => !isHome(p) && isSectionPage(p, pages));
  for (const { entity, nodes } of plan.entities) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const words = new Map<string, string>();
    for (const [id, urls] of matchPages(nodes, hubPages, plan.context)) {
      for (const url of urls) words.set(url, id);
    }
    const ids: string[] = [];
    for (const page of hubPages) {
      const id = pageLinks?.has(page.url) ? pageLinks.get(page.url) : words.get(page.url);
      const n = id ? byId.get(id) : undefined;
      if (!n || n.isRoot || n.hub) continue;
      n.hub = "site";
      ids.push(n.id);
    }
    for (const id of ids) {
      const n = byId.get(id) as NodeDraft;
      if (n.parentId && !byId.get(n.parentId)?.hub) delete n.parentId;
    }
    found.set(entity, ids);
  }
  return found;
}

/**
 * True for a search that is just the client's own name: "desaak", "de saak", or "saak" for De
 * Saak (the name without its small words).
 */
export function ownBrand(ctx: Pick<ClientContext, "site" | "market">) {
  const brands = brandTokens(ctx);
  const nameKey = variantKey(ctx.site.name, ctx.market.language);
  return (q: string) => {
    const key = variantKey(q, ctx.market.language);
    return (
      (!!nameKey && key === nameKey) || (isBrandQuery(q, brands) && key.split(" ").length <= 2)
    );
  };
}

export interface PageScore {
  /** Weighted share of the query's words found on the page (title, H1, URL). */
  score: number;
  /** Weighted share of the page's H1 words that the query covers: the page's own topic. */
  h1: number;
}

const SKIP_KINDS = new Set<SitePage["kind"]>(["home", "about", "contact"]);
const isHome = (p: PageRef) => p.kind === "home" || p.url === "/";

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
  const nameRe = new RegExp(ctx.site.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
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

const CONTENT_KINDS = new Set(["blog", "guide"]);

/** Below this monthly volume a childless supporting page under a hub becomes a section of it. */
export const FOLD_VOLUME = 20;

/** Step 2: labels and hub choices in, finished maps out. */
export function finishMaps(input: {
  plan: MapPlan;
  labels: Map<string, NodeLabel>;
  pages?: PageRef[];
  /** Existing page URL → the node it serves (null: none), from the model (link.ts). */
  pageLinks?: Map<string, string | null>;
  /** Existing page URL → a second node it clearly competes for too (link.ts). */
  pageAlso?: Map<string, string>;
  runId: string;
  createdAt: string;
  costUsd: number;
}): SiteMaps {
  const { plan, labels } = input;
  const ctx = plan.context;
  const maps: TopicalMap[] = [];
  for (const { entity, nodes: drafts } of plan.entities) {
    const root = drafts[0] as NodeDraft;
    let nodes = drafts;
    let byId = new Map(nodes.map((n) => [n.id, n]));

    // Hubs from the model for top-level pages, kept only when valid and loop-free.
    const parent = new Map<string, string>();
    for (const n of nodes) if (!n.isRoot) parent.set(n.id, n.parentId ?? root.id);
    const loops = (id: string, candidate: string) => {
      let p: string | undefined = candidate;
      const seen = new Set([id]);
      while (p && p !== root.id) {
        if (seen.has(p)) return true;
        seen.add(p);
        p = parent.get(p);
      }
      return false;
    };
    for (const n of nodes) {
      if (n.isRoot || n.parentId) continue;
      const pick = labels.get(n.id)?.parent;
      const hub = pick && pick !== "root" ? byId.get(pick) : undefined;
      if (!hub || hub === n || hub.isRoot) continue;
      if (n.section === "core" && hub.section === "outer") continue;
      if (loops(n.id, hub.id)) continue;
      parent.set(n.id, hub.id);
    }
    // Existing pages: the model's page-by-page answer when it gave one ("none" included); else,
    // and for pages it skipped, the word score. One page sits on one node.
    const pageList = input.pages ?? [];
    const kindOf = new Map(pageList.map((p) => [p.url, p.kind]));
    const words = matchPages(nodes, pageList, ctx);
    const wordNode = new Map<string, string>();
    for (const [id, urls] of words) for (const url of urls) wordNode.set(url, id);
    const linked = new Map<string, string[]>();
    const add = (id: string, url: string) => linked.set(id, [...(linked.get(id) ?? []), url]);
    const home = pageList.find(isHome);
    if (home) add(root.id, home.url);
    for (const page of pageList) {
      if (isHome(page) || SKIP_KINDS.has(page.kind)) continue;
      const judged = input.pageLinks?.has(page.url);
      const id = judged ? input.pageLinks?.get(page.url) : wordNode.get(page.url);
      if (id && byId.has(id) && id !== root.id) add(id, page.url);
    }

    // Query Deserves a Page: a small supporting page with nothing under it and no existing page
    // becomes a section of the hub it sits under, instead of a thin page of its own.
    const hasKids = new Set(parent.values());
    const folded = new Map<string, MapSection[]>();
    for (const n of nodes) {
      const p = parent.get(n.id);
      if (n.isRoot || n.hub || n.section !== "outer" || !p || p === root.id) continue;
      if (n.volume >= FOLD_VOLUME || hasKids.has(n.id) || linked.has(n.id)) continue;
      folded.set(p, [
        ...(folded.get(p) ?? []),
        {
          clusterId: n.clusterId ?? n.id,
          mainQuery: n.mainQuery,
          qdp: "section",
          queries: n.queries,
          volume: n.volume,
        },
      ]);
      parent.delete(n.id);
    }
    if (folded.size) {
      nodes = nodes.filter((n) => n.isRoot || parent.has(n.id));
      byId = new Map(nodes.map((n) => [n.id, n]));
    }
    const sectionsOf = (n: NodeDraft) =>
      [...n.sections, ...(folded.get(n.id) ?? [])].sort((a, b) => b.volume - a.volume);

    const children = new Map<string, NodeDraft[]>();
    for (const [id, p] of parent) {
      const list = children.get(p) ?? [];
      list.push(byId.get(id) as NodeDraft);
      children.set(p, list);
    }
    const level = (n: NodeDraft) =>
      n.isRoot ? "root" : parent.get(n.id) === root.id ? "seed" : "node";

    // Priority: tier x intent x demand, banded by rank. The root is always 1.
    const maxVol = Math.max(10, ...nodes.map((n) => n.volume));
    const score = (n: NodeDraft) =>
      TIER_WEIGHT[n.section] *
      INTENT_WEIGHT[n.intent.main] *
      (Math.log10(n.volume + 10) / Math.log10(maxVol + 10));
    const ranked = nodes.filter((n) => !n.isRoot).sort((a, b) => score(b) - score(a));
    const band = new Map<string, number>([[root.id, 1]]);
    ranked.forEach((n, i) => {
      const p = (i + 1) / ranked.length;
      band.set(n.id, p <= 0.1 ? 1 : p <= 0.3 ? 2 : p <= 0.6 ? 3 : p <= 0.85 ? 4 : 5);
    });

    // Quality nodes (step 13): the strongest core pages, a handful, linked from the homepage.
    const coreRanked = ranked.filter((n) => n.section === "core");
    const qualityCount = Math.max(3, Math.min(12, Math.ceil(coreRanked.length * 0.1)));
    const quality = new Set([root.id, ...coreRanked.slice(0, qualityCount).map((n) => n.id)]);

    const scores = scorePages(nodes, pageList, ctx);
    const scoreOf = (url: string, id: string) => scores.get(url)?.get(id) ?? { score: 0, h1: 0 };
    const pagesOf = (n: NodeDraft) =>
      (linked.get(n.id) ?? [])
        .map((url) => ({ url, kind: kindOf.get(url) ?? "other", ...scoreOf(url, n.id) }))
        .map((x) => (x.url === "/" || x.kind === "home" ? { ...x, score: 1, h1: 1 } : x))
        .sort((a, b) => b.score + b.h1 - (a.score + a.h1));

    // Proposed URLs: core flat, outer under its hub (Koray step 16); an existing URL is kept.
    const used = new Set<string>();
    const unique = (url: string) => {
      let u = url;
      for (let i = 2; used.has(u); i++) u = url.replace(/\/$/, `-${i}/`);
      used.add(u);
      return u;
    };
    const urlOf = new Map<string, string>();
    const seedOf = (n: NodeDraft): NodeDraft | undefined => {
      let cur: NodeDraft | undefined = n;
      while (cur && parent.get(cur.id) !== root.id) cur = byId.get(parent.get(cur.id) ?? "");
      return cur;
    };
    const lastSegment = (url: string) => url.split("/").filter(Boolean).pop() ?? "";
    // Core pages and seeds first (flat), then outer pages under their seed's slug, so every
    // outer page in one branch shares one folder: /fysio-dry-needling/dry-needling-nek/.
    const flatFirst = [root, ...ranked].sort((a, b) => Number(isNested(a)) - Number(isNested(b)));
    function isNested(n: NodeDraft) {
      return !n.isRoot && n.section === "outer" && parent.get(n.id) !== root.id;
    }
    for (const n of flatFirst) {
      const existing = pagesOf(n)[0];
      let url: string;
      if (existing) url = existing.url;
      else if (n.isRoot) url = "/";
      else if (!isNested(n)) url = `/${slugify(n.mainQuery)}/`;
      else {
        const seed = seedOf(n);
        const folder = seed && seed !== n ? lastSegment(urlOf.get(seed.id) ?? "") : "";
        url = folder ? `/${folder}/${slugify(n.mainQuery)}/` : `/${slugify(n.mainQuery)}/`;
      }
      if (existing) used.add(url);
      urlOf.set(n.id, existing ? url : unique(url));
    }

    // Link plan (step 20).
    const weights = termWeights(nodes.map((n) => [n.mainQuery, ...n.queries].join(" ")));
    const text = (n: NodeDraft) => [n.mainQuery, ...n.queries].join(" ");
    const seeds = nodes.filter((n) => level(n) === "seed");
    const nearestCore = (n: NodeDraft): NodeDraft => {
      let p = byId.get(parent.get(n.id) ?? "");
      while (p && !p.isRoot && p.section !== "core") p = byId.get(parent.get(p.id) ?? "");
      return p ?? root;
    };
    const linksOf = (n: NodeDraft): LinkOut[] => {
      const out: LinkOut[] = [];
      const seen = new Set<string>([n.id]);
      const add = (to: NodeDraft | undefined, type: LinkOut["type"]) => {
        if (!to || seen.has(to.id)) return;
        seen.add(to.id);
        out.push({ to: to.id, type, anchor: to.mainQuery });
      };
      if (!n.isRoot) {
        const p = byId.get(parent.get(n.id) ?? "") as NodeDraft;
        add(p, p.section === "core" ? "to_core" : "parent");
        if (n.section === "outer" && p.section !== "core") add(nearestCore(n), "to_core");
      }
      // Home links its quality nodes as such (step 13), before its other children.
      if (n.isRoot) for (const id of quality) add(byId.get(id), "from_home");
      const kids = (children.get(n.id) ?? []).sort((a, b) => score(b) - score(a));
      for (const k of kids.slice(0, 12)) add(k, "child");
      // Seeds are all siblings under the root: they get topical bridges instead (below).
      if (!n.isRoot && level(n) !== "seed") {
        const sibs = (children.get(parent.get(n.id) ?? "") ?? [])
          .filter((s) => s !== n)
          .sort(
            (a, b) =>
              (a.section === n.section ? 0 : 1) - (b.section === n.section ? 0 : 1) ||
              score(b) - score(a),
          );
        for (const s of sibs.slice(0, 2)) add(s, "sibling");
      }
      if (level(n) === "seed") {
        const near = seeds
          .filter((s) => s !== n)
          .map((s) => ({ s, sim: termSimilarity(text(n), text(s), weights) }))
          .sort((a, b) => b.sim - a.sim)
          .slice(0, 3);
        for (const { s } of near) add(s, "bridge");
      }
      return out;
    };

    const mapNodes: MapNode[] = [root, ...ranked].map((n) => {
      const label = labels.get(n.id) ?? {};
      const pagesHere = pagesOf(n);
      const top = pagesHere[0];
      // A page that sits elsewhere but competes for this search too (the model's "also").
      const rivals = top
        ? [...(input.pageAlso ?? [])]
            .filter(([url, id]) => id === n.id && !pagesHere.some((p) => p.url === url))
            .map(([url]) => url)
        : [];
      const conflictUrls = [...pagesHere.map((p) => p.url), ...rivals];
      const conflict =
        !n.isRoot && conflictUrls.length >= 2
          ? {
              urls: conflictUrls,
              suggestion:
                rivals.length ||
                (pagesHere.some((p) => CONTENT_KINDS.has(p.kind)) &&
                  pagesHere.some((p) => !CONTENT_KINDS.has(p.kind)))
                  ? ("differentiate" as const)
                  : ("merge" as const),
            }
          : undefined;
      const p = parent.get(n.id);
      return {
        id: n.id,
        section: n.section,
        level: level(n),
        ...(p ? { parentId: p } : {}),
        ...(n.hub ? { hub: n.hub } : {}),
        rawNode: {
          entity,
          attribute: label.attribute?.trim() || (n.isRoot ? "overview" : n.mainQuery),
        },
        macroContext: label.macroContext?.trim() || n.mainQuery,
        ...(n.clusterId ? { clusterId: n.clusterId } : {}),
        mainQuery: n.mainQuery,
        queries: n.queries,
        sections: sectionsOf(n),
        intent: n.intent,
        proposedUrl: urlOf.get(n.id) as string,
        existingPage: top ? { url: top.url, matchScore: Math.round(top.score * 100) / 100 } : null,
        ...(conflict ? { conflict } : {}),
        demand: {
          volume: n.volume,
          ...(n.cpc !== undefined ? { cpc: n.cpc } : {}),
          ...(n.gscImpressions ? { gscImpressions: n.gscImpressions } : {}),
        },
        priority: band.get(n.id) ?? 5,
        flags: { quality: quality.has(n.id), trending: false },
        linksOut: linksOf(n),
        aiOverview: n.aiOverview,
        status: top ? (isWordMatch(top) ? "exists_covered" : "exists_weak") : "idea",
        why: (label.why?.trim().length ?? 0) >= 10 ? (label.why as string).trim() : n.qdpWhy,
      };
    });
    const centralEntity =
      ctx.centralEntities.find((e) => e.name === entity) ?? ctx.centralEntities[0];
    maps.push({
      header: {
        site: ctx.site.url,
        runId: input.runId,
        createdAt: input.createdAt,
        sourceContext: ctx.sourceContext,
        centralEntity: centralEntity as ClientContext["centralEntities"][number],
        centralSearchIntent: ctx.centralSearchIntent,
        costUsd: input.costUsd,
      },
      nodes: mapNodes,
    });
  }
  return { site: ctx.site.url, maps };
}
