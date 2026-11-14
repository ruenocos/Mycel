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
 * Then Query Deserves a Page (doc 11): a cluster with enough demand is a page; a smaller one
 * becomes a section on the page it is closest to, and one without demand is micro context
 * (answered in passing, e.g. an FAQ) on that page. Doubtful clusters are flagged for a person.
 */

export const CLUSTER_VERSION = "1";

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
}

/** The pure clustering + QDP logic; the step around it fetches the SERPs. */
export function clusterQueries(input: ClusterInput): {
  clusters: ClusterDetail[];
  stats: { ambiguousMembers: number; borderlineMembers: number };
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
    members: { q: FilteredQuery; shared: number; keys: Set<string> }[];
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

  // Build clusters, then decide QDP.
  const ids = new Set<string>();
  const clusters: (ClusterDetail & { _hubKeys: Set<string> })[] = drafts.map((d) => {
    const qs = d.members.map((m) => m.q);
    const main = [...qs].sort(
      (a, b) =>
        (b.metrics.volume ?? -1) - (a.metrics.volume ?? -1) ||
        (b.metrics.gscImpressions ?? -1) - (a.metrics.gscImpressions ?? -1),
    )[0] as FilteredQuery;
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
      label: qs.some((q) => q.label === "core") ? ("core" as const) : ("related" as const),
      ...(entity ? { entity } : {}),
      members,
      demand: {
        volume: qs.reduce((n, q) => n + (q.metrics.volume ?? 0), 0),
        gscImpressions: qs.reduce((n, q) => n + (q.metrics.gscImpressions ?? 0), 0),
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
  const weights = termWeights(clusters.map((c) => c.mainQuery));
  for (const c of clusters) {
    if (c.qdpWhy) continue;
    let host: (typeof clusters)[number] | undefined;
    let bestScore = 0;
    let bestOverlap = 0;
    for (const p of pages) {
      const overlap = intersect(c._hubKeys, p._hubKeys);
      const score = overlap / o.minShared + termSimilarity(c.mainQuery, p.mainQuery, weights);
      if (score > bestScore) {
        bestScore = score;
        bestOverlap = overlap;
        host = p;
      }
    }
    const hasDemand = c.demand.volume > 0 || c.demand.gscImpressions > 0;
    if (!host || bestScore < 0.25) {
      if (hasDemand) {
        c.qdp = "page";
        c.qdpWhy =
          "Own page by default: some demand, and no existing page is close enough to host it.";
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
    const near =
      bestOverlap > 0
        ? `shares ${bestOverlap} result${bestOverlap === 1 ? "" : "s"} with "${host.mainQuery}"`
        : `closest in wording to "${host.mainQuery}"`;
    c.qdpWhy = hasDemand
      ? `Section on "${host.mainQuery}": too little demand for its own page (${c.demand.volume}/month), ${near}.`
      : `Micro context on "${host.mainQuery}": no measured demand, answer it in passing (FAQ), ${near}.`;
  }
  return {
    clusters: clusters.map(({ _hubKeys, ...c }) => c),
    stats: { ambiguousMembers: ambiguous, borderlineMembers: borderline },
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
      const { clusters, stats } = clusterQueries({
        queries: kept.filter((q) => serps.has(q.text)),
        serps,
        siteHost: host,
        options: input.options,
      });
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
          ...stats,
        },
      };
      ctx.log.info("clusters", out.stats);
      return out;
    },
  });
}
