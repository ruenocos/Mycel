import type {
  ClientContext,
  ClusterTrend,
  LeftOut,
  MapHeader,
  MapNode,
  MapSection,
  MenuGroup,
  SignalSet,
  SiteMaps,
  SiteSection,
  TopicalMap,
} from "@mycel/schema";
import { pageTerms } from "../signals/glossary.ts";
import { applyBudget } from "./budget.ts";
import { checkText, claimFacts, plainName, plainWhy, signalWhy } from "./check.ts";
import { wordRivals } from "./conflict.ts";
import { planFirst } from "./first-plan.ts";
import { type InventoryEntry, pageInventory } from "./inventory.ts";
import { linkPlan } from "./links.ts";
import { type Intent, type MapPlan, type NodeDraft, type NodeLabel, tokens } from "./plan.ts";
import { CONTENT_KINDS, FOLD, HUB_KINDS, SKIP_KINDS } from "./rules.ts";
import {
  assignSections,
  type SiteSectionsResult,
  sectionFolder,
  siteSections,
  TOP_LEVEL,
} from "./sections.ts";
import { isHome, isWordMatch, matchPages, type PageRef, pageTitle, scorePages } from "./site.ts";
import { proposeUrls } from "./urls.ts";
import { pageValue, stageOf, type Tier, tierOf, topOfferings } from "./value.ts";

/**
 * Koray steps 13-16 and 20, the deterministic finish: hubs from the model, pages that don't
 * belong left out, existing pages on their map page (and every page's job), tiny pages folded
 * into sections, the page budget and value-ranked first plan (issue #42), quality nodes, URLs
 * and the link plan.
 */

const TIER_WEIGHT = { core: 1, outer: 0.6 } as const;
const INTENT_WEIGHT: Record<Intent, number> = {
  transactional: 1,
  commercial: 1,
  local: 1,
  informational: 0.7,
  navigational: 0.4,
};

/** True when hanging id under candidate would make a loop. */
function createsLoop(
  parent: Map<string, string>,
  rootId: string,
  id: string,
  candidate: string,
): boolean {
  let p: string | undefined = candidate;
  const seen = new Set([id]);
  while (p && p !== rootId) {
    if (seen.has(p)) return true;
    seen.add(p);
    p = parent.get(p);
  }
  return false;
}

/**
 * Parent per page: the word rule, else the model's hub for a top-level page when valid (not
 * itself, not the root, a core page never under an outer one, no loops), else the root.
 */
export function resolveParents(
  nodes: NodeDraft[],
  labels: Map<string, NodeLabel>,
): Map<string, string> {
  const root = nodes.find((n) => n.isRoot) as NodeDraft;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parent = new Map<string, string>();
  for (const n of nodes) if (!n.isRoot) parent.set(n.id, n.parentId ?? root.id);
  for (const n of nodes) {
    if (n.isRoot || n.parentId || n.hub) continue;
    const pick = labels.get(n.id)?.parent;
    const hub = pick && pick !== "root" ? byId.get(pick) : undefined;
    if (!hub || hub === n || hub.isRoot) continue;
    if (n.section === "core" && hub.section === "outer") continue;
    if (createsLoop(parent, root.id, n.id, hub.id)) continue;
    parent.set(n.id, hub.id);
  }
  return parent;
}

/** Takes a page out of the tree; its children move up to its parent. */
function detach(parent: Map<string, string>, id: string) {
  const up = parent.get(id);
  for (const [k, p] of parent) if (p === id && up) parent.set(k, up);
  parent.delete(id);
}

/**
 * Query Deserves a Page: a new page with nothing under it, under a hub, becomes a section of that
 * hub when almost nobody searches for it (FOLD.always), or when it is a small question with cheap
 * clicks (FOLD.informational). A small search with costly clicks (B2B) keeps its own page.
 */
export function shouldFold(n: NodeDraft): boolean {
  if (n.volume <= FOLD.always) return n.volume === 0 || (n.cpc ?? 0) < FOLD.maxCpc;
  return (
    n.volume <= FOLD.informational &&
    n.section === "outer" &&
    n.intent.main === "informational" &&
    (n.cpc ?? 0) < FOLD.maxCpc
  );
}

export interface FinishInput {
  plan: MapPlan;
  labels: Map<string, NodeLabel>;
  pages?: PageRef[];
  /** Existing page URL → the node it serves (null: none), from the model (link.ts). */
  pageLinks?: Map<string, string | null>;
  /** Existing page URL → a second node it clearly competes for too (link.ts). */
  pageAlso?: Map<string, string>;
  /** Per entity: theme hubs the model proposed and the pages that move under a hub (group.ts). */
  groups?: Map<string, { themes: NodeDraft[]; parents: Map<string, string> }>;
  /** The site's sections and menu groups as the reader found them (issue #51). */
  sections?: SiteSection[];
  menu?: MenuGroup[];
  /** Map signals (issue #63): trends per cluster, competitor coverage, the market around. */
  signals?: SignalSet;
  runId: string;
  createdAt: string;
  costUsd: number;
}

/** Step 2: labels and hub choices in, finished maps out. */
export function finishMaps(input: FinishInput): SiteMaps {
  const { plan } = input;
  const ctx = plan.context;
  const pageList = input.pages ?? [];
  const maps: TopicalMap[] = [];
  const site = siteSections({
    pages: pageList,
    sections: input.sections ?? [],
    menu: input.menu ?? [],
    ...(ctx.business ? { business: ctx.business } : {}),
    language: ctx.market.language,
  });
  const suggested = new Map<string, SiteSection>();
  const used = new Set<string>();
  const jobs = new Map<string, InventoryEntry>();
  const rank: Record<InventoryEntry["job"], number> = {
    serves: 0,
    competes: 1,
    supports: 2,
    outside: 3,
  };
  for (const { entity, nodes } of plan.entities) {
    const { map, inventory, sections } = finishOne(input, entity, nodes, pageList, site);
    // A page has one job over all maps: the strongest one.
    for (const e of inventory) {
      const had = jobs.get(e.url);
      if (!had || rank[e.job] < rank[had.job]) jobs.set(e.url, e);
    }
    for (const s of sections.suggested) suggested.set(s.key, s);
    for (const k of sections.used) used.add(k);
    maps.push(map);
  }
  const inventory = [...jobs.values()];
  const outside = inventory
    .filter((e) => e.job === "outside")
    .map((e) => ({ url: e.url, kind: e.kind, title: e.title }));
  const siteSectionList = [
    ...site.sections,
    ...(used.has(TOP_LEVEL) && !site.sections.some((s) => s.key === TOP_LEVEL)
      ? [
          {
            key: TOP_LEVEL,
            name: "Top level",
            folder: "/",
            source: "folder" as const,
            categories: [],
          },
        ]
      : []),
    ...[...suggested.values()].map((s) => ({ ...s, suggested: true })),
  ];
  const sig = input.signals;
  const glossary = sig?.glossary?.length ? { glossary: sig.glossary } : {};
  const personas = sig?.personas?.length ? { personas: sig.personas } : {};
  const market =
    sig && (sig.trends || sig.competitors)
      ? {
          market: {
            competitors: sig.competitors?.sites ?? [],
            gaps: sig.competitors?.gaps ?? [],
            topics: sig.trends?.topics ?? [],
            trendIdeas: sig.trends?.ideas ?? [],
          },
        }
      : {};
  return {
    site: ctx.site.url,
    maps,
    siteSections: siteSectionList,
    inventory,
    ...market,
    ...glossary,
    ...personas,
    outside,
  };
}

/** The central entity's Wikidata check for this map's header. */
function entityCheckOf(sig: SignalSet | undefined, entity: string): Pick<MapHeader, "entityCheck"> {
  const e = sig?.entities?.find((x) => x.name === entity);
  return e ? { entityCheck: e } : {};
}

/** What the signals add to a page's value input. */
function signalValue(
  t: ClusterTrend | undefined,
  rivals: string[] | undefined,
): { trend?: ClusterTrend["label"]; competitors?: number } {
  return { ...(t ? { trend: t.label } : {}), ...(rivals ? { competitors: rivals.length } : {}) };
}

/** The node's trend as the map shows it. */
function trendField(t: ClusterTrend | undefined): Pick<MapNode, "trend"> {
  if (!t) return {};
  return {
    trend: {
      label: t.label,
      ...(t.change !== undefined ? { change: t.change } : {}),
      peakMonths: t.peakMonths,
      ...(t.publishBy ? { publishBy: t.publishBy } : {}),
    },
  };
}

function finishOne(
  input: FinishInput,
  entity: string,
  drafts: NodeDraft[],
  pageList: PageRef[],
  site: SiteSectionsResult,
): {
  map: TopicalMap;
  inventory: InventoryEntry[];
  sections: { suggested: SiteSection[]; used: Set<string> };
} {
  const { labels } = input;
  const ctx = input.plan.context;
  const root = drafts[0] as NodeDraft;
  const groups = input.groups?.get(entity);
  let nodes = [...drafts, ...(groups?.themes ?? [])];
  let byId = new Map(nodes.map((n) => [n.id, n]));

  // Hubs from the model for top-level pages, then theme groups, kept only when valid.
  const parent = resolveParents(nodes, labels);
  for (const [id, hubId] of groups?.parents ?? []) {
    const n = byId.get(id);
    const hub = byId.get(hubId);
    if (!n || !hub || n.isRoot || n.hub === "site" || n.hub === "offering" || hub === n) continue;
    if (n.section === "core" && hub.section === "outer") continue;
    if (createsLoop(parent, root.id, id, hubId)) continue;
    parent.set(id, hubId);
  }

  // Existing pages: the model's page-by-page answer when it gave one ("none" included); else,
  // and for pages it skipped, the word score. One page sits on one node.
  const kindOf = new Map(pageList.map((p) => [p.url, p.kind]));
  const wordNode = new Map<string, string>();
  for (const [id, urls] of matchPages(nodes, pageList, ctx)) {
    for (const url of urls) wordNode.set(url, id);
  }
  const linked = new Map<string, string[]>();
  const add = (id: string, url: string) => linked.set(id, [...(linked.get(id) ?? []), url]);
  const home = pageList.find(isHome);
  if (home) add(root.id, home.url);
  for (const page of pageList) {
    if (isHome(page) || SKIP_KINDS.has(page.kind)) continue;
    const id = input.pageLinks?.has(page.url)
      ? input.pageLinks.get(page.url)
      : wordNode.get(page.url);
    if (id && byId.has(id) && id !== root.id) add(id, page.url);
  }
  // Existing pages first (step 5): a page on no node whose words fully match a new page's
  // search serves it; improving that page beats writing a twin.
  const onNode = new Set([...linked.values()].flat());
  const early = scorePages(nodes, pageList, ctx);
  for (const page of pageList) {
    if (isHome(page) || SKIP_KINDS.has(page.kind) || onNode.has(page.url)) continue;
    const twin = [...(early.get(page.url) ?? [])]
      .filter(([id, s]) => !linked.has(id) && id !== root.id && isWordMatch(s))
      .sort(([, a], [, b]) => b.score + b.h1 - (a.score + a.h1))[0];
    if (twin) {
      add(twin[0], page.url);
      onNode.add(page.url);
    }
  }

  // Pages that don't belong in this business's map (another business, a place it doesn't
  // serve, outside its offer) leave the tree; an existing page or a hub always stays.
  const leftOut: LeftOut[] = [];
  for (const n of nodes) {
    const drop = labels.get(n.id)?.drop;
    if (!drop || n.isRoot || n.hub || linked.has(n.id)) continue;
    leftOut.push({ mainQuery: n.mainQuery, volume: n.volume, reason: drop });
    detach(parent, n.id);
  }
  // A theme hub that lost its pages goes too.
  const kidCount = new Map<string, number>();
  for (const p of parent.values()) kidCount.set(p, (kidCount.get(p) ?? 0) + 1);
  for (const n of nodes) {
    if (n.hub === "theme" && parent.has(n.id) && (kidCount.get(n.id) ?? 0) < 2)
      detach(parent, n.id);
  }

  const folded = new Map<string, MapSection[]>();
  const asSection = (n: NodeDraft): MapSection => ({
    clusterId: n.clusterId ?? n.id,
    mainQuery: n.mainQuery,
    qdp: "section",
    queries: n.queries,
    volume: n.volume,
  });
  // Two new pages the model gave the same title are one page: the smaller becomes a section.
  const sameName = new Map<string, NodeDraft>();
  const titleKey = (n: NodeDraft) =>
    (labels.get(n.id)?.name ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const kidsNow = new Set(parent.values());
  for (const n of [...nodes].sort((a, b) => b.volume - a.volume)) {
    const key = titleKey(n);
    if (!key || n.isRoot || n.hub || !parent.has(n.id)) continue;
    const keep = sameName.get(key);
    if (!keep) {
      sameName.set(key, n);
      continue;
    }
    if (linked.has(n.id) || kidsNow.has(n.id)) continue;
    folded.set(keep.id, [...(folded.get(keep.id) ?? []), asSection(n)]);
    parent.delete(n.id);
  }

  // Tiny pages become sections of their hub (shouldFold).
  const hasKids = new Set(parent.values());
  for (const n of nodes) {
    const p = parent.get(n.id);
    if (n.isRoot || n.hub || !p || p === root.id) continue;
    if (hasKids.has(n.id) || linked.has(n.id) || !shouldFold(n)) continue;
    folded.set(p, [...(folded.get(p) ?? []), asSection(n)]);
    parent.delete(n.id);
  }
  nodes = nodes.filter((n) => n.isRoot || parent.has(n.id));
  byId = new Map(nodes.map((n) => [n.id, n]));
  const level = (n: NodeDraft) =>
    n.isRoot ? "root" : parent.get(n.id) === root.id ? "seed" : "node";

  const scores = scorePages(nodes, pageList, ctx);
  const scoreOf = (url: string, id: string) => scores.get(url)?.get(id) ?? { score: 0, h1: 0 };
  const pagesOf = (n: NodeDraft) =>
    (linked.get(n.id) ?? [])
      .map((url) => ({ url, kind: kindOf.get(url) ?? "other", ...scoreOf(url, n.id) }))
      .map((x) => (x.url === "/" || x.kind === "home" ? { ...x, score: 1, h1: 1 } : x))
      // A site hub is its section page first, whatever an article on it scores.
      .sort(
        (a, b) =>
          (n.hub === "site" ? Number(HUB_KINDS.has(b.kind)) - Number(HUB_KINDS.has(a.kind)) : 0) ||
          b.score + b.h1 - (a.score + a.h1),
      );

  // Competing pages. A page that sits elsewhere but competes for this search too (the model's
  // "also", or its words fully match this page's searches: wordRivals) or an article next to an
  // offer page are told apart; two pages of one kind for one search merge. The model judges
  // each conflict afterwards (conflict.ts).
  const rivalsByWords = wordRivals({
    nodes: nodes.map((n) => {
      const own = pagesOf(n)[0];
      return { id: n.id, isRoot: n.isRoot, hub: !!n.hub, ...(own ? { page: own.url } : {}) };
    }),
    scores,
  });
  const conflictOf = (n: NodeDraft) => {
    const here = pagesOf(n);
    if (n.isRoot || !here[0]) return undefined;
    const rivals = [
      ...new Set([
        ...[...(input.pageAlso ?? [])].filter(([, id]) => id === n.id).map(([url]) => url),
        ...(rivalsByWords.get(n.id) ?? []),
      ]),
    ].filter((url) => !here.some((p) => p.url === url));
    const urls = [...here.map((p) => p.url), ...rivals];
    if (urls.length < 2) return undefined;
    const content = here.filter((p) => CONTENT_KINDS.has(p.kind));
    const differentiate = rivals.length > 0 || (content.length > 0 && content.length < here.length);
    return { urls, suggestion: differentiate ? ("differentiate" as const) : ("merge" as const) };
  };
  const statusOf = (n: NodeDraft) => {
    const top = pagesOf(n)[0];
    return top ? (isWordMatch(top) ? "exists_covered" : "exists_weak") : "idea";
  };

  // The offering a page serves: its own (words), the model's, else its nearest hub's.
  const offeringOf = (n: NodeDraft): string | undefined => {
    const seen = new Set<string>();
    for (let cur: NodeDraft | undefined = n; cur && !seen.has(cur.id); ) {
      seen.add(cur.id);
      const id = cur.offeringId ?? labels.get(cur.id)?.offering;
      if (id) return id;
      const up = parent.get(cur.id);
      cur = up ? byId.get(up) : undefined;
    }
    return undefined;
  };

  // Map signals (issue #63): a page's trend (step 14) and the competitors on it (step 11).
  const trendByCluster = new Map(
    (input.signals?.trends?.clusters ?? []).map((t) => [t.clusterId, t]),
  );
  const coverByCluster = new Map(
    (input.signals?.competitors?.coverage ?? []).map((c) => [c.clusterId, c.competitors]),
  );
  // The persona a page is mainly for (step 1).
  const personaByCluster = new Map(
    (input.signals?.personas ?? []).flatMap((p) => p.clusters.map((c) => [c, p.id] as const)),
  );
  const personaOf = (n: NodeDraft): Pick<MapNode, "persona"> => {
    const id = n.clusterId ? personaByCluster.get(n.clusterId) : undefined;
    return id ? { persona: id } : {};
  };
  const trendOf = (n: NodeDraft) => (n.clusterId ? trendByCluster.get(n.clusterId) : undefined);
  const rivalsOf = (n: NodeDraft) => (n.clusterId ? coverByCluster.get(n.clusterId) : undefined);
  const nowMonth = new Date(input.createdAt).getUTCMonth() + 1;
  const soon = (n: NodeDraft) => {
    const by = trendOf(n)?.publishBy;
    return by !== undefined && (by - nowMonth + 12) % 12 <= 3;
  };

  // Value (step 6): offering tier x buying stage x click price x opportunity (x signals).
  const business = ctx.business;
  const valueById = new Map<string, number>();
  const tierById = new Map<string, Tier>();
  for (const n of nodes) {
    const tier = tierOf(business, offeringOf(n), n.section);
    tierById.set(n.id, tier);
    valueById.set(
      n.id,
      pageValue({
        tier,
        intent: n.intent.main,
        ...(n.cpc !== undefined ? { cpc: n.cpc } : {}),
        existing: linked.has(n.id),
        seen: n.gscImpressions > 0,
        ...signalValue(trendOf(n), rivalsOf(n)),
      }),
    );
  }
  const valueOfNode = (n: NodeDraft) => valueById.get(n.id) ?? 0;

  // The page budget (step 6): a year of work; the rest to the backlog or a section.
  const nodeWords = (n: NodeDraft) =>
    tokens(`${n.mainQuery} ${labels.get(n.id)?.name ?? n.name ?? ""}`, ctx.market.language);
  const budget = applyBudget(
    nodes.map((n) => {
      const st = statusOf(n);
      const off = offeringOf(n);
      const p = parent.get(n.id);
      return {
        id: n.id,
        isRoot: n.isRoot,
        ...(p ? { parentId: p } : {}),
        create: st === "idea",
        work: st === "exists_weak" || !!conflictOf(n),
        locked: n.hub === "offering" || n.hub === "site",
        theme: n.hub === "theme",
        ...(off ? { offeringId: off } : {}),
        tier: tierById.get(n.id) ?? "none",
        stage: stageOf(n.intent.main),
        value: valueOfNode(n),
        volume: n.volume,
        words: nodeWords(n),
      };
    }),
  );
  for (const [theme, up] of budget.dissolved) {
    for (const [k, p] of parent) if (p === theme) parent.set(k, up || root.id);
    parent.delete(theme);
  }
  for (const [host, ids] of budget.sections) {
    for (const id of ids) {
      const n = byId.get(id);
      if (!n) continue;
      folded.set(host, [...(folded.get(host) ?? []), asSection(n), ...(folded.get(id) ?? [])]);
      parent.delete(id);
    }
  }
  for (const id of budget.backlog) {
    const n = byId.get(id);
    if (!n) continue;
    const off = offeringOf(n);
    leftOut.push({
      mainQuery: n.mainQuery,
      volume: n.volume,
      reason: "over_budget",
      ...(off ? { offeringId: off } : {}),
      value: valueOfNode(n),
    });
    parent.delete(id);
  }
  nodes = nodes.filter((n) => n.isRoot || parent.has(n.id));
  byId = new Map(nodes.map((n) => [n.id, n]));
  const sectionsOf = (n: NodeDraft) =>
    [...n.sections, ...(folded.get(n.id) ?? [])].sort((a, b) => b.volume - a.volume);

  // Link weight of a page: tier x intent x demand (quality nodes and the link plan).
  const maxVol = Math.max(10, ...nodes.map((n) => n.volume));
  const score = (n: NodeDraft) =>
    TIER_WEIGHT[n.section] *
    INTENT_WEIGHT[n.intent.main] *
    (Math.log10(n.volume + 10) / Math.log10(maxVol + 10));
  const ranked = nodes.filter((n) => !n.isRoot).sort((a, b) => score(b) - score(a));

  // Quality nodes (step 13): the strongest core pages, a handful, linked from the homepage.
  const coreRanked = ranked.filter((n) => n.section === "core");
  const qualityCount = Math.max(3, Math.min(12, Math.ceil(coreRanked.length * 0.1)));
  const quality = new Set([root.id, ...coreRanked.slice(0, qualityCount).map((n) => n.id)]);

  const all = [root, ...ranked];
  const demand = new Map<string, number>();
  for (const n of all) {
    const off = offeringOf(n);
    if (off) demand.set(off, (demand.get(off) ?? 0) + n.volume);
  }
  const topIds = topOfferings(business, demand);
  const actions = planFirst(
    all.map((n) => {
      const st = statusOf(n);
      const p = parent.get(n.id);
      const off = offeringOf(n);
      return {
        id: n.id,
        isRoot: n.isRoot,
        ...(p ? { parentId: p } : {}),
        existing: st === "exists_covered" ? "covered" : st === "exists_weak" ? "weak" : null,
        conflict: !!conflictOf(n),
        value: valueOfNode(n),
        volume: n.volume,
        money: n.section === "core" || stageOf(n.intent.main) !== "learn",
        // Without a profile every core page serves a top offering (the old tiers).
        top: business ? !!off && topIds.has(off) : n.section === "core",
        ...(off ? { offeringId: off } : {}),
        ...(soon(n) ? { soon: true } : {}),
      };
    }),
  );

  // Names for people: a site hub's own heading, else the model's title, else the theme's name.
  for (const n of all) {
    const top = pagesOf(n)[0];
    const page = n.hub === "site" && top ? pageList.find((p) => p.url === top.url) : undefined;
    const fromPage = page ? pageTitle(page, ctx.site.name) : "";
    // The model's words pass the fact check (step 7) or give way to data.
    const facts = claimFacts(ctx, [n.mainQuery, ...n.queries]);
    const passes = (t: string | undefined) => !!t && checkText(t, facts).length === 0;
    const label = labels.get(n.id)?.name?.trim();
    const name =
      fromPage ||
      (passes(label) ? label : undefined) ||
      (passes(n.name) ? n.name : undefined) ||
      (n.isRoot ? n.name : plainName(n.mainQuery));
    if (name) n.name = name;
  }
  const offeringName = (id: string | undefined) =>
    id ? ctx.business?.offerings.find((o) => o.id === id)?.name : undefined;
  const whyOf = (n: NodeDraft) => {
    const why = labels.get(n.id)?.why?.trim() ?? "";
    const facts = claimFacts(ctx, [n.mainQuery, ...n.queries]);
    if (why.length >= 10 && checkText(why, facts).length === 0) return why;
    if (n.isRoot) return n.qdpWhy;
    if (n.hub === "theme" && n.qdpWhy.length >= 10 && checkText(n.qdpWhy, facts).length === 0)
      return n.qdpWhy;
    return plainWhy(n, ctx.market.language, offeringName(offeringOf(n)));
  };

  // The words a page should cover: glossary terms in its searches and their other names (12.1).
  const glossaryList = input.signals?.glossary ?? [];
  const termsField = (n: NodeDraft): Pick<MapNode, "terms"> => {
    if (!glossaryList.length) return {};
    const terms = pageTerms(
      [n.mainQuery, ...n.queries, ...n.sections.map((x) => x.mainQuery)],
      glossaryList,
      ctx.market.language,
    );
    return terms.length ? { terms } : {};
  };

  // The why, with what the signals add in plain words (issue #63).
  const withSignals = (why: string, n: NodeDraft) => {
    if (n.isRoot || n.hub === "theme" || n.hub === "site") return why;
    const t = trendOf(n);
    const rivals = rivalsOf(n);
    const extra = signalWhy(
      { ...(t ? { trend: t } : {}), ...(rivals ? { competitors: rivals } : {}) },
      ctx.market.language,
    );
    return extra ? `${why.replace(/\s*$/, "")} ${extra}` : why;
  };

  // Site sections (issue #51): every page gets one; a new page's URL uses its folder.
  const placed = assignSections({
    nodes: all.map((n) => {
      const top = pagesOf(n)[0];
      return {
        id: n.id,
        isRoot: n.isRoot,
        tier: n.section,
        intent: n.intent.main,
        mainQuery: n.mainQuery,
        ...(n.name ? { name: n.name } : {}),
        ...(n.hub ? { hub: n.hub } : {}),
        ...(n.offeringId ? { offeringId: n.offeringId } : {}),
        ...(top ? { existing: top.url } : {}),
      };
    }),
    parent,
    site,
    ...(ctx.business ? { business: ctx.business } : {}),
    language: ctx.market.language,
    ...(ctx.market.city ? { city: ctx.market.city } : {}),
  });
  const sectionList = [...site.sections, ...placed.suggested];
  const sectionOf = (id: string) => {
    const at = placed.of.get(id);
    const s = at ? sectionList.find((x) => x.key === at.key) : undefined;
    return { at, s };
  };
  // Slugs from the page's name when the name only uses searched words (step 7): the name is
  // how the site will call it, the searches prove nobody gets an invented word in a URL.
  const slugText = (n: NodeDraft) => {
    if (!n.name || n.isRoot) return undefined;
    const lang = ctx.market.language;
    const searched = tokens([n.mainQuery, ...n.queries].join(" "), lang);
    const named = tokens(n.name, lang);
    return named.size > 0 && [...named].every((w) => searched.has(w)) ? n.name : undefined;
  };
  const slugOf = (n: NodeDraft) => {
    const t = slugText(n);
    return t ? { slugText: t } : {};
  };
  const urlOf = proposeUrls({
    nodes: all.map((n) => {
      const top = pagesOf(n)[0];
      const { at, s } = sectionOf(n.id);
      // A suggested section has no folder yet: its pages keep the old URL rules.
      const folder = at && !at.suggested ? (sectionFolder(s, at.category) ?? "/") : undefined;
      return {
        id: n.id,
        isRoot: n.isRoot,
        section: n.section,
        informational: n.intent.main === "informational",
        mainQuery: n.mainQuery,
        ...slugOf(n),
        ...(top ? { existing: top.url } : {}),
        ...(folder !== undefined ? { folder } : {}),
      };
    }),
    parent,
    pages: pageList,
  });
  const linksOf = linkPlan({ nodes, root, parent, score, quality });

  const siteSectionOf = (id: string): Pick<MapNode, "siteSection"> => {
    const { at, s } = sectionOf(id);
    if (!at) return {};
    return {
      siteSection: {
        key: at.key,
        name: s?.name ?? "Top level",
        ...(s?.role ? { role: s.role } : {}),
        ...(at.category ? { category: at.category } : {}),
        ...(at.suggested ? { suggested: true } : {}),
        why: at.why,
      },
    };
  };
  const mapNodes: MapNode[] = all.map((n) => {
    const offeringId = n.isRoot ? undefined : offeringOf(n);
    const label = labels.get(n.id) ?? {};
    const top = pagesOf(n)[0];
    const conflict = conflictOf(n);
    const p = parent.get(n.id);
    const act = actions.get(n.id) ?? { action: "keep" as const, priority: 5 };
    return {
      id: n.id,
      section: n.section,
      level: level(n),
      ...(p ? { parentId: p } : {}),
      ...(n.hub ? { hub: n.hub } : {}),
      ...(n.name ? { name: n.name } : {}),
      ...(offeringId ? { offeringId } : {}),
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
      priority: act.priority,
      action: act.action,
      ...(act.wave ? { wave: act.wave } : {}),
      ...(act.step ? { planStep: act.step } : {}),
      ...(n.isRoot ? {} : { value: valueOfNode(n) }),
      flags: { quality: quality.has(n.id), trending: trendOf(n)?.label === "rising" },
      ...trendField(trendOf(n)),
      ...(rivalsOf(n)?.length ? { competitors: rivalsOf(n) } : {}),
      ...termsField(n),
      ...personaOf(n),
      ...siteSectionOf(n.id),
      linksOut: linksOf(n),
      aiOverview: n.aiOverview,
      status: statusOf(n),
      why: withSignals(whyOf(n), n),
    };
  });
  // Every existing page's job (step 5).
  const inventory = pageInventory({
    nodes: all.map((n) => ({
      id: n.id,
      isRoot: n.isRoot,
      section: n.section,
      ...(n.name ? { name: n.name } : {}),
      pages: pagesOf(n).map((p) => p.url),
      conflict: conflictOf(n)?.urls ?? [],
    })),
    pages: pageList,
    scores,
    language: ctx.market.language,
    title: (p) => pageTitle(p, ctx.site.name),
  });
  const centralEntity =
    ctx.centralEntities.find((e) => e.name === entity) ?? ctx.centralEntities[0];
  return {
    inventory,
    map: {
      header: {
        site: ctx.site.url,
        runId: input.runId,
        createdAt: input.createdAt,
        sourceContext: ctx.sourceContext,
        centralEntity: centralEntity as ClientContext["centralEntities"][number],
        centralSearchIntent: ctx.centralSearchIntent,
        ...entityCheckOf(input.signals, entity),
        costUsd: input.costUsd,
      },
      nodes: mapNodes,
      leftOut,
    },
    sections: {
      suggested: placed.suggested.filter((s) =>
        [...placed.of.values()].some((v) => v.key === s.key),
      ),
      used: new Set([...placed.of.values()].map((v) => v.key)),
    },
  };
}
