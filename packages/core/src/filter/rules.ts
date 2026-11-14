import type {
  ClientContext,
  FilteredQuery,
  Query,
  QuerySource,
  RelevanceLabel,
} from "@mycel/schema";
import { brandTokens, isBrandQuery } from "../research/seeds.ts";

/**
 * Step 9, the deterministic half (issue #17): cheap rules that need no model, run before it.
 * Every rule is generic; client differences come from the context (notThis, brand, market).
 */

/** Folds case, accents and punctuation, so "Wat kost een café?" and "wat kost een cafe" merge. */
export function canonical(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True when `phrase` appears in `text` as whole words (both canonical). */
export function hasPhrase(text: string, phrase: string): boolean {
  const p = canonical(phrase);
  if (!p) return false;
  return ` ${canonical(text)} `.includes(` ${p} `);
}

export interface RuleHit {
  rule: string;
  reason: string;
}

const MAX_WORDS = 10;

/** The first rule a query breaks, or null. Order matters: the cheapest, surest rules first. */
export function ruleFor(q: Query, ctx: ClientContext, brands = brandTokens(ctx)): RuleHit | null {
  const text = canonical(q.text);
  if (!text || !/\p{L}/u.test(text)) return { rule: "junk", reason: "no words" };
  if (text.split(" ").length > MAX_WORDS)
    return { rule: "junk", reason: "too long to be a search" };
  if (/\b[a-z0-9-]+\.(nl|com|be|de|org|net|eu|io)\b/.test(q.text.toLowerCase())) {
    return { rule: "navigational", reason: "contains a web address" };
  }
  // No rule on q.language: DataforSEO's detected_language is mostly wrong on short queries
  // ("fysiotherapie" → fi, "kamerplant" → en). The model judges language instead.
  for (const e of ctx.centralEntities) {
    for (const n of e.notThis) {
      if (hasPhrase(q.text, n)) return { rule: "not this", reason: `not this: ${n}` };
    }
  }
  if (isBrandQuery(q.text, brands)) return { rule: "own brand", reason: "the client's own brand" };
  return null;
}

/**
 * Merges queries that only differ in case, accents or punctuation. The one with the most volume
 * (then impressions) stays and takes the others' sources; the rest are dropped as duplicates.
 */
export function mergeDuplicates(queries: Query[]): { queries: FilteredQuery[]; merged: number } {
  const groups = new Map<string, Query[]>();
  for (const q of queries) {
    const k = canonical(q.text) || q.normalized;
    const g = groups.get(k);
    if (g) g.push(q);
    else groups.set(k, [q]);
  }
  const out: FilteredQuery[] = [];
  let merged = 0;
  for (const g of groups.values()) {
    const sorted = [...g].sort(
      (a, b) =>
        (b.metrics.volume ?? -1) - (a.metrics.volume ?? -1) ||
        (b.metrics.gscImpressions ?? -1) - (a.metrics.gscImpressions ?? -1) ||
        a.normalized.length - b.normalized.length,
    );
    const [head, ...rest] = sorted as [Query, ...Query[]];
    const keep: FilteredQuery = {
      ...head,
      sources: [...head.sources],
      metrics: { ...head.metrics },
    };
    for (const r of rest) {
      for (const s of r.sources) if (!keep.sources.includes(s)) keep.sources.push(s);
      const m = keep.metrics;
      if (m.gscImpressions === undefined && r.metrics.gscImpressions !== undefined) {
        m.gscImpressions = r.metrics.gscImpressions;
        if (r.metrics.gscClicks !== undefined) m.gscClicks = r.metrics.gscClicks;
        if (r.metrics.gscPosition !== undefined) m.gscPosition = r.metrics.gscPosition;
      }
      out.push({ ...r, filter: { kept: false, reason: `duplicate of "${head.text}"` } });
      merged++;
    }
    out.push(keep);
  }
  return { queries: out, merged };
}

/** Independent kinds of evidence; prominence counts how many point at a query. */
const SOURCE_GROUP: Record<QuerySource, string> = {
  seed: "own",
  gsc: "own",
  dfs_ranked_site: "own",
  page: "own",
  serp_paa: "serp",
  serp_related: "serp",
  dfs_related: "ideas",
  dfs_suggestions: "ideas",
  dfs_ranked_competitor: "competitors",
};
const GROUPS = 4;

export const RELEVANCE: Record<RelevanceLabel, number> = {
  core: 1,
  outer: 0.6,
  bridge: 0.25,
  off: 0,
};

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Scores in 0..1.
 * - relevance: the model's tier (core 1, outer 0.6, bridge 0.25, off 0).
 * - prominence: how many independent kinds of evidence surfaced it (own data, SERP features,
 *   keyword ideas, competitors), out of four.
 * - popularity: search volume or GSC impressions on a log scale, relative to the dataset's top.
 */
export function scoreQueries(queries: FilteredQuery[]): void {
  const maxVol = Math.max(0, ...queries.map((q) => q.metrics.volume ?? 0));
  const maxImp = Math.max(0, ...queries.map((q) => q.metrics.gscImpressions ?? 0));
  const scale = (v: number | undefined, max: number) =>
    max > 0 && v ? Math.log10(v + 1) / Math.log10(max + 1) : 0;
  for (const q of queries) {
    if (!q.filter?.kept || !q.label) continue;
    const groups = new Set(q.sources.map((s) => SOURCE_GROUP[s]));
    q.scores = {
      relevance: RELEVANCE[q.label],
      prominence: round(groups.size / GROUPS),
      popularity: round(
        Math.max(scale(q.metrics.volume, maxVol), scale(q.metrics.gscImpressions, maxImp)),
      ),
    };
  }
}
