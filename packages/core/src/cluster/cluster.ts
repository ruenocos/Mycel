import {
  ClientContext,
  type ClusterDetail,
  type ClusterMember,
  ClusterSet,
  FilteredQueries,
  type FilteredQuery,
  type Market,
  MIN_SHARED_URLS,
} from "@mycel/schema";
import { z } from "zod";
import { canonical } from "../filter/rules.ts";
import { cleanDomain } from "../research/collect.ts";
import { defineStep } from "../step.ts";

/**
 * Koray step 10 (issue #18, ADR 0003): queries whose top-10 results share 3+ URLs belong on one
 * page. Hub-based: queries are taken in priority order; each joins the existing hub it overlaps
 * most with (at least `minShared` URLs), or becomes a new hub. Comparing with the hub, not with
 * any member, stops chains (A~B, B~C, but A and C have nothing in common).
 *
 * Then two merge passes (doc 11 near-duplicates, doc 24 "merge small groups with one intent"):
 * spelling variants of the same words fold into one cluster, and a small cluster whose hub
 * shares enough results with a member of an earlier cluster joins it.
 *
 * Then Query Deserves a Page (doc 11): a core or outer cluster with enough demand is a page; a
 * smaller one becomes a section on the page it is closest to, and one without demand is micro
 * context (answered in passing, e.g. an FAQ) on that page. A bridge cluster (broader than the
 * central entity) never gets a page of its own: it is mentioned on the closest page. Doubtful
 * clusters are flagged for a person.
 */

/**
 * 2: relevance tiers (bridge never a page), variant and same-intent merges.
 * 3: same-topic merges (aliases), chain merges within one tier, a bridge needs a shared result
 * with its host page or it leaves the map.
 * 4: same topic + same tier merges without a shared result; a bridge query never names a cluster.
 * 5: topics snap to the central entity's name; a topic that is the entity itself only merges
 *    plain-name queries without a shared result; bridges don't add to a page's demand; the main
 *    query prefers the plain form.
 * 6: variant keys of every member count (not only hubs); topic keys ignore case, word order and
 *    plurals; a bridge can sit on the page with its own topic without a shared result.
 * 7: a variant of any member (not only the hub) finds its earlier cluster; a cluster's topic is
 *    its members' majority topic, not just its hub's.
 */
export const CLUSTER_VERSION = "7";

/** What core needs from a SERP. The connectors' SerpResult satisfies it structurally. */
export interface ClusterSerp {
  keyword: string;
  organic: {
    rank: number;
    key: string;
    urlSource: "url" | "breadcrumb" | "domain";
    domain: string | null;
  }[];
  aiOverview: { present: boolean; references: { url: string; domain: string | null }[] };
  itemTypes?: string[];
}

// biome-ignore lint/suspicious/noExplicitAny: the recorder shape belongs to connectors; core passes its StepContext
type Rec = any;
export interface SerpBatchPort {
  serpOrganicBatch(
    keywords: string[],
    market: Market,
    rec: Rec,
  ): Promise<{
    serps: Map<string, ClusterSerp>;
    blocked: string[];
    failed: { keyword: string; error: string }[];
  }>;
}

/** SERP features that make a query prominent (doc 02, step 9: prominence from SERP features). */
export const PROMINENT_FEATURES = [
  "ai_overview",
  "people_also_ask",
  "featured_snippet",
  "answer_box",
  "knowledge_graph",
  "local_pack",
  "map",
  "video",
  "images",
  "top_stories",
  "popular_products",
  "discussions_and_forums",
] as const;
const FEATURE_SET = new Set<string>(PROMINENT_FEATURES);

/** URLs usable for overlap: top 10, and real URLs or breadcrumb keys. A bare domain is too coarse (ADR 0010). */
export function overlapKeys(serp: ClusterSerp): Set<string> {
  return new Set(
    serp.organic.filter((o) => o.rank <= 10 && o.urlSource !== "domain").map((o) => o.key),
  );
}

const intersect = (a: Set<string>, b: Set<string>) => {
  let n = 0;
  for (const k of a) if (b.has(k)) n++;
  return n;
};

export const ClusterOptions = z.object({
  minShared: z.number().int().positive().default(MIN_SHARED_URLS),
  /** A cluster is a page with this much monthly volume... */
  minPageVolume: z.number().int().nonnegative().default(50),
  /** ...or this much for core (money) clusters... */
  minCoreVolume: z.number().int().nonnegative().default(10),
  /** ...or this many GSC impressions (90 days)... */
  minPageImpressions: z.number().int().nonnegative().default(100),
  /** ...or this many queries that Google answers with the same results. */
  minPageMembers: z.number().int().positive().default(3),
  /** Below this many usable URLs, the hub's SERP is too thin to trust. */
  minUsableUrls: z.number().int().positive().default(5),
});
export type ClusterOptions = z.infer<typeof ClusterOptions>;

export const STOPWORDS: Record<string, Set<string>> = {
  nl: new Set(["de", "het", "een", "en", "van", "voor", "in", "op", "met", "te", "s", "je", "jij"]),
  en: new Set(["the", "a", "an", "and", "of", "for", "in", "on", "with", "to", "s"]),
};

/**
 * A light stemmer per market language, only for spotting spelling variants (never shown).
 * Dutch: plural -en/-s, inflected -e, doubled consonants and long vowels ("grote kamerplanten"
 * and "groot kamerplant" both become "grot kamerplant"). Other languages: plural -s only.
 */
export function stemToken(tok: string, language: string): string {
  let t = tok;
  if (language === "nl") {
    if (t.length > 4 && t.endsWith("en")) t = t.slice(0, -2);
    else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
    else if (t.length > 3 && t.endsWith("e") && !t.endsWith("ee")) t = t.slice(0, -1);
    t = t.replace(/([bdfgklmnprst])\1$/, "$1").replace(/(aa|ee|oo|uu)/g, (m) => m.charAt(0));
    return t;
  }
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  return t;
}

/** Same key = the same words up to plural, inflection, spelling and word order. */
export function variantKey(text: string, language: string): string {
  const stop = STOPWORDS[language] ?? new Set<string>();
  const stems = canonical(text)
    .split(" ")
    .filter((t) => t && !stop.has(t))
    .map((t) => stemToken(t, language));
  return [...new Set(stems)].sort().join(" ");
}

const TIERS = ["core", "outer", "bridge"] as const;
type Tier = (typeof TIERS)[number];
const tierOf = (q: FilteredQuery): Tier =>
  q.label === "core" || q.label === "bridge" ? q.label : "outer";

/** Priority for hub order: relevance first, then demand. */
function priority(q: FilteredQuery): number {
  const s = q.scores;
  return (s?.relevance ?? 0) * 10 + (s?.popularity ?? 0) * 5 + (s?.prominence ?? 0);
}

/** Token weights (IDF) over all queries, for "weighted term importance" similarity (doc 11). */
export function termWeights(texts: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const t of texts) {
    for (const tok of new Set(canonical(t).split(" ").filter(Boolean))) {
      df.set(tok, (df.get(tok) ?? 0) + 1);
    }
  }
  const n = texts.length || 1;
  const w = new Map<string, number>();
  for (const [tok, d] of df) w.set(tok, Math.log((n + 1) / d));
  return w;
}

/** Weighted Jaccard of two queries' tokens; rare (meaningful) words count most. */
export function termSimilarity(a: string, b: string, weights: Map<string, number>): number {
  const ta = new Set(canonical(a).split(" ").filter(Boolean));
  const tb = new Set(canonical(b).split(" ").filter(Boolean));
  let inter = 0;
  let union = 0;
  for (const t of new Set([...ta, ...tb])) {
    const w = weights.get(t) ?? 1;
    union += w;
    if (ta.has(t) && tb.has(t)) inter += w;
  }
  return union ? inter / union : 0;
}

const slug = (s: string) =>
  canonical(s)
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "cluster";

const round = (n: number) => Math.round(n * 1000) / 1000;

export interface ClusterInput {
  queries: FilteredQuery[];
  serps: Map<string, ClusterSerp>;
  siteHost: string;
  options: ClusterOptions;
  /** Market language, for spotting spelling variants. Default "nl". */
  language?: string;
  /** Central entity names, to snap short topic names ("Business Central") to the full one. */
  entities?: string[];
}

/** The pure clustering + QDP logic; the step around it fetches the SERPs. */
export function clusterQueries(input: ClusterInput): {
  clusters: ClusterDetail[];
  /** Queries that have no place in the map, with the reason (e.g. a bridge with no host). */
  leftOut: { query: string; reason: string }[];
  stats: { ambiguousMembers: number; borderlineMembers: number; merged: number };
} {
  const { options: o } = input;
  const ordered = [...input.queries].sort(
    (a, b) =>
      priority(b) - priority(a) ||
      (b.metrics.volume ?? 0) - (a.metrics.volume ?? 0) ||
      a.normalized.localeCompare(b.normalized),
  );
  type Draft = {
    hub: FilteredQuery;
    hubKeys: Set<string>;
    members: { q: FilteredQuery; shared: number; keys: Set<string>; joined?: string }[];
    reasons: string[];
  };
  const drafts: Draft[] = [];
  let ambiguous = 0;
  let borderline = 0;
  for (const q of ordered) {
    const serp = input.serps.get(q.text);
    if (!serp) continue;
    const keys = overlapKeys(serp);
    let best: Draft | undefined;
    let bestShared = 0;
    const matches: Draft[] = [];
    for (const d of drafts) {
      const n = intersect(keys, d.hubKeys);
      if (n >= o.minShared) matches.push(d);
      if (n > bestShared) {
        bestShared = n;
        best = d;
      }
    }
    if (best && bestShared >= o.minShared) {
      best.members.push({ q, shared: bestShared, keys });
      if (bestShared === o.minShared) borderline++;
      if (matches.length > 1) {
        ambiguous++;
        const others = matches.filter((m) => m !== best).map((m) => `"${m.hub.text}"`);
        best.reasons.push(`"${q.text}" also matches ${others.join(", ")}`);
      }
    } else {
      const reasons: string[] = [];
      if (keys.size < o.minUsableUrls) {
        reasons.push(`thin SERP: only ${keys.size} usable URLs for "${q.text}"`);
      }
      drafts.push({ hub: q, hubKeys: keys, members: [{ q, shared: keys.size, keys }], reasons });
    }
  }

  // Merge pass 1: spelling variants (same words up to plural, inflection, order) are one topic.
  // Merge pass 2: a small cluster whose hub shares minShared results with a member of an earlier
  // cluster, and at least one with its hub, has the same intent (doc 24). One hop only.
  const language = input.language ?? "nl";
  const textWeights = termWeights(ordered.map((q) => q.text));
  let merged = 0;
  const fold = (into: Draft, from: Draft, why: string) => {
    for (const m of from.members) {
      into.members.push({ ...m, shared: intersect(m.keys, into.hubKeys), joined: why });
    }
    into.reasons.push(...from.reasons);
    merged++;
  };
  const byKey = new Map<string, Draft>();
  const afterVariants: Draft[] = [];
  for (const d of drafts) {
    // Any member's form counts on this side too: "kosten plat dak vervangen" in one cluster and
    // "vervangen plat dak kosten" in another are the same words, so the same page.
    let first: Draft | undefined;
    for (const m of [d.hub, ...d.members.map((x) => x.q)]) {
      const k = variantKey(m.text, language);
      first = k ? byKey.get(k) : undefined;
      if (first) break;
    }
    if (first) fold(first, d, `spelling variant of "${first.hub.text}"`);
    else {
      // Every member's form counts: "groothandel software" may be a member elsewhere.
      for (const m of d.members) {
        const k = variantKey(m.q.text, language);
        if (k && !byKey.has(k)) byKey.set(k, d);
      }
      afterVariants.push(d);
    }
  }
  // Merge pass 1b: aliases. The filter model names each query's topic canonically ("Microsoft
  // Dynamics NAV" for navision, microsoft nav, dynamics nav); same topic = one cluster.
  const entityRaw = (input.entities ?? []).map(
    (e) => new Set(canonical(e).split(" ").filter(Boolean)),
  );
  // Topics are English by contract; keys ignore case, word order, small words and plurals.
  const topicKey = (t: string) => variantKey(t, "en");
  const entityNames = (input.entities ?? []).map(topicKey);
  const entityTokens = entityNames.map((k) => new Set(k.split(" ").filter(Boolean)));
  const subset = (a: string[], b: Set<string>) => a.length > 0 && a.every((t) => b.has(t));
  /** A short form of a central entity's name ("business central") snaps to the full name. */
  const topicOf = (q: FilteredQuery) => {
    const t = q.topic ? topicKey(q.topic) : "";
    const i = entityTokens.findIndex((set) => subset(t.split(" "), set));
    return i >= 0 ? (entityNames[i] as string) : t;
  };
  /** The query is just a name of the entity ("microsoft business central"), nothing more. */
  const plainName = (q: FilteredQuery) =>
    entityRaw.some((set) => subset(canonical(q.text).split(" "), set));
  const byTopicTier = new Map<string, Draft>();
  const byTopic = new Map<string, Draft>();
  const afterTopics: Draft[] = [];
  /** A cluster's topic is what most of its members are about; the hub's breaks a tie. */
  const draftTopic = (d: Draft) => {
    const count = new Map<string, number>();
    for (const m of d.members) {
      const t = topicOf(m.q);
      if (t) count.set(t, (count.get(t) ?? 0) + 1);
    }
    const own = topicOf(d.hub);
    let best = own;
    let n = own ? (count.get(own) ?? 0) : 0;
    for (const [t, c] of count) if (c > n) [best, n] = [t, c];
    return best;
  };
  for (const d of afterVariants) {
    const topic = draftTopic(d);
    const sameTier = topic ? byTopicTier.get(`${topic}|${tierOf(d.hub)}`) : undefined;
    const any = topic ? byTopic.get(topic) : undefined;
    // Aliases of one thing often have unrelated SERPs, so the same tier is enough; across tiers
    // a shared result is still needed. A topic that is the entity itself is too broad for that:
    // without a shared result, only plain names of the entity merge.
    const generic = entityNames.includes(topic);
    let into: Draft | undefined;
    if (sameTier && (!generic || (plainName(d.hub) && plainName(sameTier.hub)))) into = sameTier;
    else if (any && intersect(d.hubKeys, any.hubKeys) >= 1) into = any;
    if (into) {
      fold(into, d, `same topic as "${into.hub.text}" (${d.hub.topic ?? topic})`);
    } else {
      if (topic) {
        if (!byTopic.has(topic)) byTopic.set(topic, d);
        const k = `${topic}|${tierOf(d.hub)}`;
        if (!byTopicTier.has(k)) byTopicTier.set(k, d);
      }
      afterTopics.push(d);
    }
  }
  const kept: Draft[] = [];
  for (const d of afterTopics) {
    let target: Draft | undefined;
    let why = "";
    if (d.members.length <= 2) {
      for (const k of kept) {
        if (tierOf(k.hub) !== tierOf(d.hub)) continue; // no drifting from outer into core etc.
        const viaHub = intersect(d.hubKeys, k.hubKeys);
        if (viaHub === 0) continue;
        const viaMember = Math.max(...k.members.map((m) => intersect(d.hubKeys, m.keys)));
        if (viaMember >= o.minShared) {
          target = k;
          why = `shares ${viaMember} results with a query on "${k.hub.text}"`;
          break;
        }
        if (
          viaHub === o.minShared - 1 &&
          termSimilarity(d.hub.text, k.hub.text, textWeights) >= 0.5
        ) {
          target = k;
          why = `near-identical wording and ${viaHub} shared results with "${k.hub.text}"`;
          break;
        }
      }
    }
    if (target) fold(target, d, why);
    else kept.push(d);
  }

  // Build clusters, then decide QDP.
  const ids = new Set<string>();
  const clusters: (ClusterDetail & { _hubKeys: Set<string> })[] = kept.map((d) => {
    const qs = d.members.map((m) => m.q);
    // The page is named after its biggest query, but never after a broader (bridge) one, and a
    // plainer form wins when it has at least half the volume ("luchtzuiverende planten" over
    // "luchtzuiverende planten onzin").
    const ranked = [...qs].sort(
      (a, b) =>
        Number(tierOf(a) === "bridge") - Number(tierOf(b) === "bridge") ||
        (b.metrics.volume ?? -1) - (a.metrics.volume ?? -1) ||
        (b.metrics.gscImpressions ?? -1) - (a.metrics.gscImpressions ?? -1),
    );
    let main = ranked[0] as FilteredQuery;
    const tokens = (q: FilteredQuery) => canonical(q.text).split(" ").filter(Boolean);
    for (const m of ranked) {
      const mt = tokens(m);
      if (
        m !== main &&
        tierOf(m) !== "bridge" &&
        mt.length < tokens(main).length &&
        subset(mt, new Set(tokens(main))) &&
        (m.metrics.volume ?? 0) * 2 >= (main.metrics.volume ?? 0)
      ) {
        main = m;
      }
    }
    // Bridge members are mentioned on the page; they don't make its demand.
    const demandOf =
      TIERS.find((t) => qs.some((q) => tierOf(q) === t)) === "bridge"
        ? qs
        : qs.filter((q) => tierOf(q) !== "bridge");
    let id = `c-${slug(main.text)}`;
    for (let i = 2; ids.has(id); i++) id = `c-${slug(main.text)}-${i}`;
    ids.add(id);
    // URLs that at least half of the members share.
    const count = new Map<string, number>();
    for (const m of d.members) for (const k of m.keys) count.set(k, (count.get(k) ?? 0) + 1);
    const sharedUrls = [...count.entries()]
      .filter(
        ([, n]) => n >= Math.max(2, Math.ceil(d.members.length / 2)) || d.members.length === 1,
      )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k]) => k);
    const hubSerp = input.serps.get(d.hub.text) as ClusterSerp;
    const features = [...new Set(hubSerp.itemTypes ?? [])].filter((t) => FEATURE_SET.has(t));
    const entities = new Map<string, number>();
    for (const q of qs) if (q.entity) entities.set(q.entity, (entities.get(q.entity) ?? 0) + 1);
    const entity = [...entities.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const members: ClusterMember[] = d.members.map((m) => {
      const serp = input.serps.get(m.q.text) as ClusterSerp;
      const feats = new Set((serp.itemTypes ?? []).filter((t) => FEATURE_SET.has(t)));
      const serpProminence = Math.min(1, feats.size / 4);
      const s = m.q.scores ?? { relevance: 0, prominence: 0, popularity: 0 };
      return {
        query: m.q.text,
        shared: m.shared,
        ...(m.joined ? { joined: m.joined } : {}),
        ...(m.q.metrics.volume !== undefined ? { volume: m.q.metrics.volume } : {}),
        ...(m.q.metrics.gscImpressions !== undefined
          ? { gscImpressions: m.q.metrics.gscImpressions }
          : {}),
        scores: {
          relevance: s.relevance,
          // Evidence from the research step, blended with SERP features now that each query has a SERP.
          prominence: round((s.prominence + serpProminence) / 2),
          popularity: s.popularity,
        },
      };
    });
    return {
      id,
      mainQuery: main.text,
      hub: d.hub.text,
      queries: qs.map((q) => q.normalized),
      sharedUrls,
      qdp: "page" as const,
      outlier: d.reasons.length > 0,
      label: TIERS.find((t) => qs.some((q) => tierOf(q) === t)) ?? ("outer" as const),
      ...(entity ? { entity } : {}),
      members,
      demand: {
        volume: demandOf.reduce((n, q) => n + (q.metrics.volume ?? 0), 0),
        gscImpressions: demandOf.reduce((n, q) => n + (q.metrics.gscImpressions ?? 0), 0),
      },
      aiOverview: {
        present: hubSerp.aiOverview.present,
        cited: hubSerp.aiOverview.references.some((r) => {
          const d2 = cleanDomain(r.domain ?? r.url);
          return d2 === input.siteHost || d2.endsWith(`.${input.siteHost}`);
        }),
      },
      serpFeatures: features,
      qdpWhy: "",
      outlierReasons: d.reasons,
      _hubKeys: d.hubKeys,
    };
  });

  // QDP: which clusters deserve a page.
  const isPage = (c: (typeof clusters)[number]) => {
    const why: string[] = [];
    if (c.label === "bridge") return why; // broader than the central entity: never its own page
    if (c.demand.volume >= o.minPageVolume) why.push(`${c.demand.volume} searches a month`);
    if (
      c.label === "core" &&
      c.demand.volume >= o.minCoreVolume &&
      c.demand.volume < o.minPageVolume
    ) {
      why.push(`core topic with ${c.demand.volume} searches a month`);
    }
    if (c.demand.gscImpressions >= o.minPageImpressions) {
      why.push(`${c.demand.gscImpressions} impressions in Search Console`);
    }
    if (c.members.length >= o.minPageMembers) {
      why.push(`${c.members.length} queries share the same results`);
    }
    return why;
  };
  const pages = clusters.filter((c) => {
    const why = isPage(c);
    if (why.length) c.qdpWhy = `Own page: ${why.join(", ")}.`;
    return why.length > 0;
  });
  const leftOut: { query: string; reason: string }[] = [];
  const hubTopic = new Map(kept.map((d) => [d.hub.text, draftTopic(d)]));
  const weights = termWeights(clusters.map((c) => c.mainQuery));
  for (const c of clusters) {
    if (c.qdpWhy) continue;
    const bridge = c.label === "bridge";
    let host: (typeof clusters)[number] | undefined;
    let bestScore = 0;
    let bestOverlap = 0;
    for (const p of pages) {
      const overlap = intersect(c._hubKeys, p._hubKeys);
      // Wording alone is too weak for a broader topic; a shared result or the same topic is needed.
      const sameTopic = !!hubTopic.get(c.hub) && hubTopic.get(c.hub) === hubTopic.get(p.hub);
      if (bridge && overlap === 0 && !sameTopic) continue;
      const score = overlap / o.minShared + termSimilarity(c.mainQuery, p.mainQuery, weights);
      if (score > bestScore) {
        bestScore = score;
        bestOverlap = overlap;
        host = p;
      }
    }
    const hasDemand = c.demand.volume > 0 || c.demand.gscImpressions > 0;
    const demandText = [
      c.demand.volume > 0 ? `${c.demand.volume} searches a month` : "",
      c.demand.gscImpressions > 0 ? `${c.demand.gscImpressions} impressions in Search Console` : "",
    ]
      .filter(Boolean)
      .join(" and ");
    if (!host || bestScore < 0.25) {
      if (bridge) {
        // Broader than the central entity and no page shares a result with it: not in the map.
        for (const m of c.members) {
          leftOut.push({
            query: m.query,
            reason: `bridge topic with no page that shares a result with it${hasDemand ? ` (${demandText})` : ""}`,
          });
        }
        c.qdpWhy = "left out";
      } else if (hasDemand) {
        c.qdp = "page";
        c.qdpWhy = `Own page by default: ${demandText}, and no existing page is close enough to host it.`;
        c.outlier = true;
        c.outlierReasons.push("small page with no close host: check if it belongs elsewhere");
        pages.push(c);
      } else {
        c.qdp = "micro";
        c.qdpWhy = "No search volume and no page close enough to host it.";
        c.outlier = true;
        c.outlierReasons.push("orphan: no demand and no host");
      }
      continue;
    }
    c.qdp = hasDemand ? "section" : "micro";
    c.hostClusterId = host.id;
    if (bridge) {
      const near2 =
        bestOverlap > 0
          ? `shares ${bestOverlap} result${bestOverlap === 1 ? "" : "s"} with it`
          : "closest in wording";
      c.qdpWhy = hasDemand
        ? `Bridge topic on "${host.mainQuery}": broader than the central entity (${demandText}), so mention it there as context instead of a page of its own; ${near2}.`
        : `Bridge topic on "${host.mainQuery}": broader than the central entity, mention it in passing; ${near2}.`;
      continue;
    }
    const near =
      bestOverlap > 0
        ? `shares ${bestOverlap} result${bestOverlap === 1 ? "" : "s"} with "${host.mainQuery}"`
        : `closest in wording to "${host.mainQuery}"`;
    c.qdpWhy = hasDemand
      ? `Section on "${host.mainQuery}": too little demand for its own page (${demandText}), ${near}.`
      : `Micro context on "${host.mainQuery}": no measured demand, answer it in passing (FAQ), ${near}.`;
  }
  const inMap = clusters.filter((c) => c.qdpWhy !== "left out");
  return {
    leftOut,
    clusters: inMap.map(({ _hubKeys, ...c }) => c),
    stats: { ambiguousMembers: ambiguous, borderlineMembers: borderline, merged },
  };
}

export const ClusterStepInput = z.object({
  context: ClientContext,
  queries: FilteredQueries,
  options: ClusterOptions.default(ClusterOptions.parse({})),
});
export type ClusterStepInput = z.input<typeof ClusterStepInput>;

export function clusterStep(port: SerpBatchPort) {
  return defineStep({
    name: "cluster",
    version: CLUSTER_VERSION,
    input: ClusterStepInput,
    output: ClusterSet,
    async run(input, ctx) {
      const kept = input.queries.queries.filter((q) => q.filter?.kept);
      const host = cleanDomain(new URL(input.context.site.url).hostname);
      const { serps, blocked, failed } = await port.serpOrganicBatch(
        kept.map((q) => q.text),
        input.context.market,
        ctx,
      );
      const unclustered = [
        ...blocked.map((query) => ({
          query,
          reason: "no SERP: not cached and live SERPs are off",
        })),
        ...failed.map((f) => ({ query: f.keyword, reason: `no SERP: ${f.error}` })),
      ];
      const missing = new Set(unclustered.map((u) => u.query));
      for (const q of kept) {
        if (!serps.has(q.text) && !missing.has(q.text)) {
          unclustered.push({ query: q.text, reason: "no SERP returned" });
        }
      }
      const { clusters, stats, leftOut } = clusterQueries({
        queries: kept.filter((q) => serps.has(q.text)),
        serps,
        siteHost: host,
        options: input.options,
        language: input.context.market.language,
        entities: input.context.centralEntities.map((e) => e.name),
      });
      unclustered.push(...leftOut);
      const count = (k: ClusterDetail["qdp"]) => clusters.filter((c) => c.qdp === k).length;
      const out = {
        site: input.queries.site,
        market: input.context.market,
        minSharedUrls: input.options.minShared,
        clusters,
        unclustered,
        stats: {
          queries: kept.length,
          clustered: clusters.reduce((n, c) => n + c.members.length, 0),
          clusters: clusters.length,
          pages: count("page"),
          sections: count("section"),
          micro: count("micro"),
          singletons: clusters.filter((c) => c.members.length === 1).length,
          outliers: clusters.filter((c) => c.outlier).length,
          bridges: clusters.filter((c) => c.label === "bridge" && c.qdp !== "page").length,
          leftOut: leftOut.length,
          ...stats,
        },
      };
      ctx.log.info("clusters", out.stats);
      return out;
    },
  });
}
