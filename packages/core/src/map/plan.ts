import type {
  ClientContext,
  ClusterDetail,
  ClusterSet,
  FilteredQuery,
  MapSection,
  PageIntent,
} from "@mycel/schema";
import { STOPWORDS, variantKey } from "../cluster/cluster.ts";
import { canonical } from "../filter/rules.ts";
import { brandTokens, isBrandQuery } from "../research/seeds.ts";
import { QUESTION_WORDS } from "./rules.ts";
import { slugify } from "./urls.ts";

/**
 * Koray steps 11-12 (issue #19), the data half: page clusters become node drafts under a root per
 * central entity, with intent, demand and a word-rule parent. Nothing here calls a model.
 *
 * - Hierarchy: a page whose words contain another page's words sits under it ("plat dak
 *   vervangen" under "dak vervangen"). Pages with no such parent get one from the model later.
 * - Intent per page: query intents weighted by volume, plus what the results page shows.
 * - Brand searches ("de saak") are the homepage: they fold into the root.
 * - Pages that are the same search spelled differently ("citroenplant", "citroen plant"), or the
 *   same search with the market's city added, are one page; equal volumes count once.
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
  /**
   * "site": an existing service, category or location page sits on it, a locked hub
   * (anchorSiteHubs). "theme": a new hub the model proposed to group pages (group.ts).
   */
  hub?: "site" | "theme";
  /** Display name when known from data: a site hub's page heading, a theme hub's name. */
  name?: string;
  qdpWhy: string;
}

/** Why the model left a page out of the map (label.ts). */
export type FitReason = "other_business" | "place_not_served" | "off_offer";

export interface NodeLabel {
  attribute?: string;
  macroContext?: string;
  why?: string;
  /** A short page title in the market language, for people. */
  name?: string;
  /** Set when the page doesn't belong in this business's map. */
  drop?: FitReason;
  /** Model's hub choice for a top-level page: a node id, or "root". */
  parent?: string;
}

export interface MapPlan {
  context: ClientContext;
  /** Per entity name: its drafts, root first. */
  entities: { entity: string; nodes: NodeDraft[] }[];
}

export const tokens = (text: string, language: string) =>
  new Set(variantKey(text, language).split(" ").filter(Boolean));

const strictSubset = (a: Set<string>, b: Set<string>) =>
  a.size > 0 && a.size < b.size && [...a].every((t) => b.has(t));

/**
 * Keys for one search however it is written, letters sorted so word order doesn't count: one from
 * word stems ("kamerplant verpotten" = "kamerplanten verpotten"), one from the words as written
 * so compounds match ("citroen plant" = "citroenplant"). The market's city is left out
 * ("sportfysiotherapie utrecht" = "sportfysiotherapie" in a Utrecht market). Two searches that
 * share a key are one search.
 */
export function searchKeys(text: string, language: string, city?: string): string[] {
  const stop = STOPWORDS[language] ?? new Set<string>();
  const cityWords = new Set(city ? canonical(city).split(" ") : []);
  const cityStems = city ? tokens(city, language) : new Set<string>();
  const letters = (words: string[], drop: Set<string>) => {
    const kept = words.filter((w) => !drop.has(w));
    return [...(kept.length ? kept : words).join("")].sort().join("");
  };
  const written = canonical(text)
    .split(" ")
    .filter((w) => w && !stop.has(w));
  return [
    ...new Set([letters([...tokens(text, language)], cityStems), letters(written, cityWords)]),
  ];
}

/** The first key of a search (see searchKeys). */
export const searchKey = (text: string, language: string, city?: string) =>
  searchKeys(text, language, city)[0] as string;

/** Groups texts that share any search key; returns a group id per text. */
function variantGroups(texts: string[], language: string, city?: string): string[] {
  const owner = new Map<string, string>();
  return texts.map((t) => {
    const keys = searchKeys(t, language, city);
    const id = keys.map((k) => owner.get(k)).find(Boolean) ?? keys[0] ?? t;
    for (const k of keys) if (!owner.has(k)) owner.set(k, id);
    return id;
  });
}

/**
 * Demand without double counting: close variants that report the same volume ("dakdekker" and
 * "dakdekkers", both 9,900) are one bucket at the data provider, so that volume counts once.
 */
export function dedupedVolume(
  c: Pick<ClusterDetail, "members" | "demand">,
  language: string,
): number {
  const groups = new Map<string, number[]>();
  const priced = c.members.filter((m) => m.volume);
  const ids = variantGroups(
    priced.map((m) => m.query),
    language,
  );
  priced.forEach((m, i) => {
    const key = ids[i] as string;
    groups.set(key, [...(groups.get(key) ?? []), m.volume as number]);
  });
  let double = 0;
  for (const vols of groups.values()) {
    const sum = vols.reduce((s, v) => s + v, 0);
    double += sum - [...new Set(vols)].reduce((s, v) => s + v, 0);
  }
  return Math.max(0, c.demand.volume - double);
}

/** Two pages for one search fold together: volumes add up unless they are the same bucket. */
const addVolume = (a: number, b: number) => (a === b ? a : a + b);

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
  /** The market is one city: service pages are local. */
  local?: boolean;
  /** A query names the market's city: a navigational vote means local. */
  place?: boolean;
  /** The main search is a question ("wat is ..."): it reads, it doesn't sell by itself. */
  question?: boolean;
}

/**
 * Intent of a page: member intents weighted by volume, results-page features, then the tier.
 * Data providers call product and place searches navigational ("business central partner",
 * "fysiotherapeut utrecht"); without a brand that only stands as local when the search names
 * the market's city, else the vote is dropped.
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
      if (!hints.local || hints.place === false) continue;
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
  if (hints.offering && !hints.question && (!first || first[0] === "informational")) {
    // People read about the service before they book it: the page sells, and answers too.
    return { main: service, mixed: !!first, source: "offering" };
  }
  if (!first) {
    const main = tier === "core" && !hints.question ? service : "informational";
    return { main, mixed: false, source: "tier" };
  }
  return { main: first[0], mixed: !!second && second[1] >= first[1] * 0.6, source: "data" };
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

/** Brand words of the client and its competitors (domains or names). */
function allBrands(context: ClientContext): string[] {
  return [
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
}

/** Step 1: page clusters become node drafts per central entity, each with its word-rule parent. */
export function planMaps(input: {
  context: ClientContext;
  clusters: ClusterSet;
  queries?: FilteredQuery[];
}): MapPlan {
  const { context, clusters } = input;
  const language = context.market.language;
  const city = context.market.city;
  const cityTokens = city ? tokens(city, language) : new Set<string>();
  const questions = QUESTION_WORDS[language] ?? new Set<string>();
  const byQuery = new Map((input.queries ?? []).map((q) => [q.normalized, q]));
  const entityNames = context.centralEntities.map((e) => e.name);
  const entityOf = (c: ClusterDetail) =>
    c.entity && entityNames.includes(c.entity) ? c.entity : (entityNames[0] as string);
  const isOwnBrand = ownBrand(context);
  const anyBrands = allBrands(context);
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
      volume: dedupedVolume(c, language),
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
      const firstWord = c.mainQuery.trim().toLowerCase().split(/\s+/)[0] ?? "";
      const hints: IntentHints = {
        brand: texts.some((t) => isOwnBrand(t) || isBrandQuery(t, anyBrands)),
        offering:
          section === "core" &&
          texts.some((t) => {
            const mine = tokens(t, language);
            return offerings.some((o) => [...o].every((x) => mine.has(x)));
          }),
        local: !!city,
        ...(city
          ? { place: texts.some((t) => [...tokens(t, language)].some((x) => cityTokens.has(x))) }
          : {}),
        question: questions.has(firstWord),
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
        volume: dedupedVolume(c, language),
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

    // One search, one page: spelling, compound and word-order variants, or the same search with
    // the city added, fold into the bigger page.
    const byKey = new Map<string, NodeDraft>();
    for (const n of [...nodes].sort((a, b) => b.volume - a.volume)) {
      if (n.isRoot) continue;
      const keys = searchKeys(n.mainQuery, language, city);
      const keep = keys.map((k) => byKey.get(k)).find(Boolean);
      if (!keep) {
        for (const k of keys) byKey.set(k, n);
        continue;
      }
      if (keep.section === "outer" && n.section === "core") keep.section = "core";
      keep.queries.push(...n.queries.filter((q) => !keep.queries.includes(q)));
      keep.sections.push(...n.sections);
      keep.volume = addVolume(keep.volume, n.volume);
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
