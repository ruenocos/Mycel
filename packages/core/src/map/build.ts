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

/**
 * Koray steps 11-14 and 20 (issue #19), the deterministic half: page clusters become map nodes
 * under a root per central entity. Data decides the structure; the model only names what data
 * can't (a hub for pages whose words don't nest, the raw-node attribute, macro context, why).
 *
 * - Hierarchy: a page whose words contain another page's words sits under it ("plat dak
 *   vervangen" under "dak vervangen"). Pages with no such parent get one from the model, chosen
 *   among the top-level pages, or stay under the root.
 * - Intent per page: query intents weighted by volume, plus what the results page shows.
 * - Priority 1-5: tier x intent x demand, banded by rank.
 * - Quality nodes (step 13): the strongest core pages, linked from the homepage.
 * - Existing pages: matched to nodes on their title, H1 and URL words; two on one node = conflict.
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
  qdpWhy: string;
}

export interface NodeLabel {
  attribute?: string;
  macroContext?: string;
  why?: string;
  /** Model's hub choice for a top-level page: a node id, or "root". */
  parent?: string;
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

/** Intent of a page: member intents weighted by volume, results-page features, then the tier. */
export function pageIntent(
  members: { intent?: string | undefined; volume: number }[],
  features: string[],
  tier: "core" | "outer",
): PageIntent {
  const score = new Map<Intent, number>();
  let total = 0;
  for (const m of members) {
    if (!m.intent || !INTENTS.includes(m.intent as Intent)) continue;
    const w = Math.max(1, m.volume);
    score.set(m.intent as Intent, (score.get(m.intent as Intent) ?? 0) + w);
    total += w;
  }
  const featureWeight = Math.max(1, total) * 0.3;
  for (const f of features) {
    const i = FEATURE_INTENT[f];
    if (i) score.set(i, (score.get(i) ?? 0) + featureWeight);
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  const [first, second] = ranked;
  if (!first) {
    return { main: tier === "core" ? "commercial" : "informational", mixed: false, source: "tier" };
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
        intent: pageIntent(members, c.serpFeatures, section),
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

/** Top-level pages that may receive a model-chosen hub, and the hubs they may pick from. */
export function hubChoices(plan: MapPlan, entity: string) {
  const nodes = plan.entities.find((e) => e.entity === entity)?.nodes ?? [];
  const top = nodes.filter((n) => !n.isRoot && !n.parentId);
  return { pages: top, hubs: top };
}

/** Matches existing pages to nodes on the words of their title, H1 and URL. */
export function matchPages(
  nodes: NodeDraft[],
  pages: PageRef[],
  language: string,
): Map<string, { url: string; score: number; kind: SitePage["kind"] }[]> {
  const found = new Map<string, { url: string; score: number; kind: SitePage["kind"] }[]>();
  const add = (id: string, m: { url: string; score: number; kind: SitePage["kind"] }) => {
    const list = found.get(id) ?? [];
    list.push(m);
    found.set(id, list);
  };
  const root = nodes.find((n) => n.isRoot);
  for (const page of pages) {
    if (page.kind === "home" || page.url === "/") {
      if (root) add(root.id, { url: page.url, score: 1, kind: page.kind });
      continue;
    }
    if (page.kind === "about" || page.kind === "contact") continue;
    const words = tokens(`${page.title} ${page.h1} ${page.url.replace(/[/-]/g, " ")}`, language);
    const h1 = tokens(page.h1, language);
    let best: { node: NodeDraft; score: number; h1: number; size: number } | undefined;
    for (const n of nodes) {
      for (const q of [n.mainQuery, ...n.queries]) {
        const t = tokens(q, language);
        if (t.size === 0) continue;
        let hit = 0;
        let inH1 = 0;
        for (const x of t) {
          if (words.has(x)) hit++;
          if (h1.has(x)) inH1++;
        }
        const score = hit / t.size;
        // Prefer full cover, then what the H1 says (the page's own topic), then the more specific
        // query, then the bigger page.
        const tie = (a: number, b: number) => (a === b ? 0 : a > b ? 1 : -1);
        const order = best
          ? tie(score, best.score) ||
            tie(inH1, best.h1) ||
            tie(t.size, best.size) ||
            tie(n.volume, best.node.volume)
          : 1;
        if (order > 0) best = { node: n, score, h1: inH1, size: t.size };
      }
    }
    if (best && best.score >= 2 / 3 && (best.size >= 2 || best.score === 1)) {
      add(best.node.id, {
        url: page.url,
        score: Math.round(best.score * 100) / 100,
        kind: page.kind,
      });
    }
  }
  return found;
}

const CONTENT_KINDS = new Set(["blog", "guide"]);

/** Step 2: labels and hub choices in, finished maps out. */
export function finishMaps(input: {
  plan: MapPlan;
  labels: Map<string, NodeLabel>;
  pages?: PageRef[];
  runId: string;
  createdAt: string;
  costUsd: number;
}): SiteMaps {
  const { plan, labels } = input;
  const ctx = plan.context;
  const language = ctx.market.language;
  const maps: TopicalMap[] = [];
  for (const { entity, nodes } of plan.entities) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const root = nodes[0] as NodeDraft;

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

    // Existing pages.
    const matched = input.pages ? matchPages(nodes, input.pages, language) : new Map();

    // Proposed URLs: core flat, outer under its hub (Koray step 16); an existing URL is kept.
    const used = new Set<string>();
    const unique = (url: string) => {
      let u = url;
      for (let i = 2; used.has(u); i++) u = url.replace(/\/$/, `-${i}/`);
      used.add(u);
      return u;
    };
    const urlOf = new Map<string, string>();
    const coreParentSlug = (n: NodeDraft): string => {
      const p = byId.get(parent.get(n.id) ?? "");
      return p && !p.isRoot ? slugify(p.mainQuery) : "";
    };
    for (const n of [root, ...ranked]) {
      const existing = (matched.get(n.id) ?? []).sort(
        (a: { score: number }, b: { score: number }) => b.score - a.score,
      )[0];
      let url: string;
      if (existing) url = existing.url;
      else if (n.isRoot) url = "/";
      else if (n.section === "core") url = `/${slugify(n.mainQuery)}/`;
      else {
        const hub = coreParentSlug(n);
        url = hub ? `/${hub}/${slugify(n.mainQuery)}/` : `/${slugify(n.mainQuery)}/`;
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
      if (n.isRoot) for (const id of quality) add(byId.get(id), "from_home");
      return out;
    };

    const mapNodes: MapNode[] = [root, ...ranked].map((n) => {
      const label = labels.get(n.id) ?? {};
      const pagesHere = (matched.get(n.id) ?? []).sort(
        (a: { score: number }, b: { score: number }) => b.score - a.score,
      ) as { url: string; score: number; kind: SitePage["kind"] }[];
      const top = pagesHere[0];
      const conflictUrls = pagesHere.filter((p) => p.score >= 2 / 3).map((p) => p.url);
      const conflict =
        !n.isRoot && conflictUrls.length >= 2
          ? {
              urls: conflictUrls,
              suggestion:
                pagesHere.some((p) => CONTENT_KINDS.has(p.kind)) &&
                pagesHere.some((p) => !CONTENT_KINDS.has(p.kind))
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
        rawNode: {
          entity,
          attribute: label.attribute?.trim() || (n.isRoot ? "overview" : n.mainQuery),
        },
        macroContext: label.macroContext?.trim() || n.mainQuery,
        ...(n.clusterId ? { clusterId: n.clusterId } : {}),
        mainQuery: n.mainQuery,
        queries: n.queries,
        sections: n.sections,
        intent: n.intent,
        proposedUrl: urlOf.get(n.id) as string,
        existingPage: top ? { url: top.url, matchScore: top.score } : null,
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
        status: top ? (top.score >= 1 ? "exists_covered" : "exists_weak") : "idea",
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
