import type {
  ClusterDetail,
  ClusterTrend,
  MonthPoint,
  TopicTrend,
  TrendIdea,
  TrendLabel,
} from "@mycel/schema";
import { normalizeQuery } from "@mycel/schema";
import { variantKey } from "../cluster/cluster.ts";
import { TRENDS } from "./rules.ts";

/**
 * Koray step 14, trending nodes (issue #63). A page's searches, summed per month, say whether
 * its topic grows, shrinks or peaks in some months; Google Trends adds the long curve of the
 * central topics and the searches rising under them. Content goes up before the peak: a
 * seasonal page gets a month to publish by.
 */

export interface HistoryLike {
  keyword: string;
  monthly: { year: number; month: number; volume: number }[];
  yearlyChangePct?: number;
}

export interface ExploreLike {
  keywords: string[];
  graph: { date: string; values: (number | null)[] }[];
  rising: { query: string; value: number }[];
}

const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

/**
 * Monthly searches of a cluster, summed over its searches. Spelling variants often come back
 * with the very same series (Google counts them as one search): such a series counts once.
 */
export function clusterSeries(
  queries: string[],
  histories: Map<string, HistoryLike>,
): { monthly: MonthPoint[]; yearlyPct?: number } {
  const seen = new Set<string>();
  const sum = new Map<string, number>();
  let weighted = 0;
  let weight = 0;
  for (const q of queries) {
    const h = histories.get(q.toLowerCase().trim());
    if (!h?.monthly.length) continue;
    const sig = h.monthly.map((m) => `${monthKey(m.year, m.month)}:${m.volume}`).join(",");
    if (seen.has(sig)) continue;
    seen.add(sig);
    for (const m of h.monthly) {
      const k = monthKey(m.year, m.month);
      sum.set(k, (sum.get(k) ?? 0) + m.volume);
    }
    if (h.yearlyChangePct !== undefined) {
      const w = h.monthly.reduce((s, m) => s + m.volume, 0) || 1;
      weighted += h.yearlyChangePct * w;
      weight += w;
    }
  }
  const monthly = [...sum.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-24)
    .map(([month, volume]) => ({ month, volume: Math.round(volume) }));
  return { monthly, ...(weight ? { yearlyPct: weighted / weight } : {}) };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

/** Peak months of a year of values (index 0 = January), or none when the year is flat. */
export function peaksOf(byMonth: number[]): number[] {
  const med = median(byMonth);
  const max = Math.max(...byMonth);
  const seasonal = med > 0 ? max >= TRENDS.seasonalRatio * med : max >= TRENDS.minMonthly * 3;
  if (!seasonal) return [];
  return byMonth
    .map((v, i) => ({ v, m: i + 1 }))
    .filter((x) => x.v >= TRENDS.peakRatio * Math.max(med, 1))
    .map((x) => x.m);
}

/** Two months before the start of the longest run of peak months (runs wrap over the new year). */
export function publishByOf(peaks: number[]): number | undefined {
  if (!peaks.length) return undefined;
  const set = new Set(peaks);
  if (set.size === 12) return undefined;
  // A run starts at a peak whose previous month is not a peak.
  const starts = peaks.filter((m) => !set.has(m === 1 ? 12 : m - 1));
  let best = starts[0] ?? (peaks[0] as number);
  let bestLen = 0;
  for (const s of starts) {
    let len = 0;
    for (let m = s; set.has(m) && len < 12; m = m === 12 ? 1 : m + 1) len++;
    if (len > bestLen) {
      best = s;
      bestLen = len;
    }
  }
  return ((best - 1 - TRENDS.leadMonths + 24) % 12) + 1;
}

const labelOf = (change: number | undefined, peaks: number[]): TrendLabel =>
  change !== undefined && change >= TRENDS.rising
    ? "rising"
    : change !== undefined && change <= TRENDS.falling
      ? "falling"
      : peaks.length
        ? "seasonal"
        : "steady";

/** A trend from monthly searches; undefined when there is too little to say anything. */
export function trendOf(
  monthly: MonthPoint[],
  yearlyPct?: number,
): Pick<ClusterTrend, "label" | "change" | "peakMonths" | "publishBy"> | undefined {
  if (monthly.length < 6) return undefined;
  const last12 = monthly.slice(-12);
  const mean = last12.reduce((s, m) => s + m.volume, 0) / last12.length;
  if (mean < TRENDS.minMonthly) return undefined;
  let change: number | undefined;
  if (monthly.length >= 15) {
    const recent = monthly.slice(-3).reduce((s, m) => s + m.volume, 0);
    const before = monthly.slice(-15, -12).reduce((s, m) => s + m.volume, 0);
    if (before > 0) change = recent / before - 1;
  }
  if (change === undefined && yearlyPct !== undefined) change = yearlyPct / 100;
  const byMonth = Array.from({ length: 12 }, () => 0);
  const counts = Array.from({ length: 12 }, () => 0);
  for (const m of last12) {
    const i = Number(m.month.slice(5)) - 1;
    byMonth[i] = (byMonth[i] ?? 0) + m.volume;
    counts[i] = (counts[i] ?? 0) + 1;
  }
  const peaks = last12.length === 12 ? peaksOf(byMonth) : [];
  const publishBy = publishByOf(peaks);
  return {
    label: labelOf(change, peaks),
    ...(change !== undefined ? { change: Math.round(change * 100) / 100 } : {}),
    peakMonths: peaks,
    ...(publishBy ? { publishBy } : {}),
  };
}

/** A topic's long curve from Google Trends (weekly or monthly points, 0-100). */
export function topicTrend(
  keyword: string,
  points: { date: string; value: number }[],
): TopicTrend | undefined {
  const byMonth = new Map<string, number[]>();
  for (const p of points) {
    const k = p.date.slice(0, 7);
    byMonth.set(k, [...(byMonth.get(k) ?? []), p.value]);
  }
  const months = [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, vs]) => ({ month, value: vs.reduce((s, v) => s + v, 0) / vs.length }));
  if (months.length < 24) return undefined;
  const avg = (xs: { value: number }[]) => xs.reduce((s, x) => s + x.value, 0) / (xs.length || 1);
  const last = avg(months.slice(-12));
  const before = avg(months.slice(-24, -12));
  const change = before > 0 ? Math.round((last / before - 1) * 100) / 100 : undefined;
  // Seasonality over the last three years, month by month.
  const year = Array.from({ length: 12 }, () => [] as number[]);
  for (const m of months.slice(-36)) year[Number(m.month.slice(5)) - 1]?.push(m.value);
  const peaks = peaksOf(year.map((vs) => vs.reduce((s, v) => s + v, 0) / (vs.length || 1)));
  return {
    keyword,
    label: labelOf(change, peaks),
    ...(change !== undefined ? { change } : {}),
    peakMonths: peaks,
  };
}

/**
 * Trends for every page cluster, the topics' long curves, and rising searches: a rising search
 * that is one of a cluster's searches marks that cluster; the others become trend ideas.
 */
export function buildTrends(input: {
  clusters: ClusterDetail[];
  histories: Map<string, HistoryLike>;
  explores: ExploreLike[];
  language: string;
}): { clusters: ClusterTrend[]; topics: TopicTrend[]; ideas: TrendIdea[]; withTrend: number } {
  const pages = input.clusters.filter((c) => c.qdp === "page");
  const byKey = new Map<string, string>();
  for (const c of input.clusters) {
    for (const q of c.queries) {
      byKey.set(normalizeQuery(q), c.id);
      byKey.set(`v:${variantKey(q, input.language)}`, c.id);
    }
  }
  const risingIn = new Set<string>();
  const ideas: TrendIdea[] = [];
  const topics: TopicTrend[] = [];
  for (const e of input.explores) {
    e.keywords.forEach((k, i) => {
      const points = e.graph
        .map((p) => ({ date: p.date, value: p.values[i] }))
        .filter((p): p is { date: string; value: number } => typeof p.value === "number");
      const t = topicTrend(k, points);
      if (t) topics.push(t);
    });
    const under = e.keywords.join(", ");
    for (const r of e.rising) {
      const id =
        byKey.get(normalizeQuery(r.query)) ?? byKey.get(`v:${variantKey(r.query, input.language)}`);
      if (id) risingIn.add(id);
      else if (!ideas.some((x) => normalizeQuery(x.query) === normalizeQuery(r.query))) {
        ideas.push({ query: r.query, growthPct: r.value, under });
      }
    }
  }
  const out: ClusterTrend[] = [];
  let withTrend = 0;
  for (const c of pages) {
    const { monthly, yearlyPct } = clusterSeries(c.queries, input.histories);
    const t = trendOf(monthly, yearlyPct);
    const rising = risingIn.has(c.id) || c.queries.some((q) => risingIn.has(q));
    if (!t && !rising) continue;
    if (t) withTrend++;
    out.push({
      clusterId: c.id,
      mainQuery: c.mainQuery,
      ...(t ?? { label: "rising" as const, peakMonths: [] }),
      ...(rising && t?.label !== "rising" && t?.label !== "falling"
        ? { label: "rising" as const }
        : {}),
      risingInTrends: rising,
      monthly,
    });
  }
  ideas.sort((a, b) => b.growthPct - a.growthPct);
  return { clusters: out, topics, ideas: ideas.slice(0, TRENDS.maxIdeas), withTrend };
}
