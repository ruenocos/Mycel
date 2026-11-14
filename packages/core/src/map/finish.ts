import type {
  ClientContext,
  LeftOut,
  MapNode,
  MapSection,
  SiteMaps,
  TopicalMap,
} from "@mycel/schema";
import { planActions } from "./actions.ts";
import { linkPlan } from "./links.ts";
import type { Intent, MapPlan, NodeDraft, NodeLabel } from "./plan.ts";
import { CONTENT_KINDS, FOLD, HUB_KINDS, SKIP_KINDS } from "./rules.ts";
import { isHome, isWordMatch, matchPages, type PageRef, pageTitle, scorePages } from "./site.ts";
import { proposeUrls } from "./urls.ts";

/**
 * Koray steps 13-16 and 20, the deterministic finish: hubs from the model, pages that don't
 * belong left out, existing pages on their map page, tiny pages folded into sections, an action
 * plan, quality nodes, URLs and the link plan.
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
  const onMap = new Set<string>();
  for (const { entity, nodes } of plan.entities) {
    const { map, linkedUrls } = finishOne(input, entity, nodes, pageList);
    for (const url of linkedUrls) onMap.add(url);
    maps.push(map);
  }
  const outside = pageList
    .filter((p) => !isHome(p) && !SKIP_KINDS.has(p.kind) && !onMap.has(p.url))
    .map((p) => ({ url: p.url, kind: p.kind, title: pageTitle(p, ctx.site.name) }));
  return { site: ctx.site.url, maps, outside };
}

function finishOne(
  input: FinishInput,
  entity: string,
  drafts: NodeDraft[],
  pageList: PageRef[],
): { map: TopicalMap; linkedUrls: string[] } {
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
    if (!n || !hub || n.isRoot || n.hub === "site" || hub === n) continue;
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
  const sectionsOf = (n: NodeDraft) =>
    [...n.sections, ...(folded.get(n.id) ?? [])].sort((a, b) => b.volume - a.volume);
  const level = (n: NodeDraft) =>
    n.isRoot ? "root" : parent.get(n.id) === root.id ? "seed" : "node";

  // Value of a page: tier x intent x demand.
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
  // "also") or an article next to an offer page are told apart; two pages of one kind for one
  // search merge. The model judges each conflict afterwards (conflict.ts).
  const conflictOf = (n: NodeDraft) => {
    const here = pagesOf(n);
    if (n.isRoot || !here[0]) return undefined;
    const rivals = [...(input.pageAlso ?? [])]
      .filter(([url, id]) => id === n.id && !here.some((p) => p.url === url))
      .map(([url]) => url);
    const urls = [...here.map((p) => p.url), ...rivals];
    if (urls.length < 2) return undefined;
    const content = here.filter((p) => CONTENT_KINDS.has(p.kind));
    const differentiate = rivals.length > 0 || (content.length > 0 && content.length < here.length);
    return { urls, suggestion: differentiate ? ("differentiate" as const) : ("merge" as const) };
  };

  const all = [root, ...ranked];
  const statusOf = (n: NodeDraft) => {
    const top = pagesOf(n)[0];
    return top ? (isWordMatch(top) ? "exists_covered" : "exists_weak") : "idea";
  };
  const actions = planActions(
    all.map((n) => {
      const st = statusOf(n);
      const p = parent.get(n.id);
      return {
        id: n.id,
        isRoot: n.isRoot,
        ...(p ? { parentId: p } : {}),
        existing: st === "exists_covered" ? "covered" : st === "exists_weak" ? "weak" : null,
        conflict: !!conflictOf(n),
        score: score(n),
      };
    }),
  );

  // Names for people: a site hub's own heading, else the model's title, else the theme's name.
  for (const n of all) {
    const top = pagesOf(n)[0];
    const page = n.hub === "site" && top ? pageList.find((p) => p.url === top.url) : undefined;
    const fromPage = page ? pageTitle(page, ctx.site.name) : "";
    const name = fromPage || labels.get(n.id)?.name?.trim() || n.name;
    if (name) n.name = name;
  }

  const urlOf = proposeUrls({
    nodes: all.map((n) => {
      const top = pagesOf(n)[0];
      return {
        id: n.id,
        isRoot: n.isRoot,
        section: n.section,
        informational: n.intent.main === "informational",
        mainQuery: n.mainQuery,
        ...(top ? { existing: top.url } : {}),
      };
    }),
    parent,
    pages: pageList,
  });
  const linksOf = linkPlan({ nodes, root, parent, score, quality });

  const mapNodes: MapNode[] = all.map((n) => {
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
      flags: { quality: quality.has(n.id), trending: false },
      linksOut: linksOf(n),
      aiOverview: n.aiOverview,
      status: statusOf(n),
      why: (label.why?.trim().length ?? 0) >= 10 ? (label.why as string).trim() : n.qdpWhy,
    };
  });
  const centralEntity =
    ctx.centralEntities.find((e) => e.name === entity) ?? ctx.centralEntities[0];
  return {
    map: {
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
      leftOut,
    },
    linkedUrls: [...linked.values()].flat(),
  };
}
