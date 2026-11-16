import type { Market } from "@mycel/schema";
import { type FileCache, requestHash } from "./cache.ts";
import { marketParams } from "./locations.ts";

/*
 * Search volume over time (Koray step 14, issue #63). Labs results already carry the last 12
 * months per keyword and a year-on-year change, so most of it comes from the cache for free;
 * Google Ads search volume fills the rest with up to 24 months, and Google Trends explore gives
 * the long curve and rising searches around the central entity and the top offerings.
 */

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" ? (v as Raw) : {});
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export interface MonthVolume {
  year: number;
  /** 1-12 */
  month: number;
  volume: number;
}

export interface KeywordHistory {
  keyword: string;
  /** Oldest first. */
  monthly: MonthVolume[];
  /** Labs' own change against a year earlier, in percent, when it gave one. */
  yearlyChangePct?: number;
}

function months(v: unknown): MonthVolume[] {
  const out: MonthVolume[] = [];
  for (const m of arr(v)) {
    const year = num(m.year);
    const month = num(m.month);
    const volume = num(m.search_volume);
    if (year && month && month >= 1 && month <= 12 && volume !== undefined) {
      out.push({ year, month, volume });
    }
  }
  return out.sort((a, b) => a.year - b.year || a.month - b.month);
}

function history(keyword: unknown, info: Raw): KeywordHistory | null {
  const k = str(keyword);
  const monthly = months(info.monthly_searches);
  if (!k || !monthly.length) return null;
  const out: KeywordHistory = { keyword: k, monthly };
  const yearly = num(obj(info.search_volume_trend).yearly);
  if (yearly !== undefined) out.yearlyChangePct = yearly;
  return out;
}

/** Histories inside one Labs result (related keywords, suggestions, ranked keywords). */
export function parseLabsHistory(endpoint: string, result: unknown): KeywordHistory[] {
  const items = arr(obj(result).items);
  const out: KeywordHistory[] = [];
  for (const i of items) {
    const h = endpoint.includes("keyword_suggestions")
      ? history(i.keyword, obj(i.keyword_info))
      : history(obj(i.keyword_data).keyword, obj(obj(i.keyword_data).keyword_info));
    if (h) out.push(h);
  }
  return out;
}

const LABS_WITH_HISTORY =
  /dataforseo_labs\/google\/(related_keywords|keyword_suggestions|ranked_keywords)\//;

/**
 * Every keyword history already paid for, by lowercased keyword. The longest series wins when a
 * keyword came back more than once. Free: it only reads the cache.
 */
export function cachedHistories(cache: FileCache): Map<string, KeywordHistory> {
  const out = new Map<string, KeywordHistory>();
  const keep = (h: KeywordHistory) => {
    const key = h.keyword.toLowerCase().trim();
    const had = out.get(key);
    if (!had || h.monthly.length > had.monthly.length) out.set(key, h);
  };
  for (const e of cache.entries()) {
    if (LABS_WITH_HISTORY.test(e.endpoint))
      for (const h of parseLabsHistory(e.endpoint, e.result)) keep(h);
    else if (e.endpoint.startsWith("keywords_data/google_ads/search_volume")) {
      for (const h of parseAdsVolume(e.result)) keep(h);
    }
  }
  return out;
}

/** Google Ads search volume: result is one item per keyword. */
export function parseAdsVolume(result: unknown): KeywordHistory[] {
  return arr(result)
    .map((i) => history(i.keyword, i))
    .filter((x): x is KeywordHistory => x !== null);
}

/**
 * Google Ads refuses some keywords outright (the whole task fails): too long, too many words or
 * symbols it doesn't take. Those are left out before the call.
 */
export const adsAccepts = (k: string) =>
  k.length <= 80 && k.split(/\s+/).length <= 10 && !/[!@%,*^()=<>{}\\[\]|;:'"~`]/.test(k);

export interface TrendsPoint {
  /** First day of the period (YYYY-MM-DD). */
  date: string;
  /** Interest per keyword, 0-100 relative to the peak, in the order asked. */
  values: (number | null)[];
}

export interface TrendsQuery {
  query: string;
  /** Top: relative interest 0-100. Rising: growth in percent ("Breakout" comes as a big number). */
  value: number;
}

export interface TrendsExplore {
  keywords: string[];
  graph: TrendsPoint[];
  top: TrendsQuery[];
  rising: TrendsQuery[];
}

/** keywords_data/google_trends/explore: a graph item and a related-queries item. */
export function parseTrendsExplore(keywords: string[], result: unknown): TrendsExplore {
  const out: TrendsExplore = { keywords, graph: [], top: [], rising: [] };
  const queries = (v: unknown) =>
    arr(v)
      .map((q) => ({ query: str(q.query) ?? "", value: num(q.value) ?? 0 }))
      .filter((q) => q.query);
  for (const item of arr(obj(result).items)) {
    if (item.type === "google_trends_graph") {
      for (const d of arr(item.data)) {
        const date = str(d.date_from);
        if (!date || d.missing_data === true) continue;
        out.graph.push({
          date,
          values: (Array.isArray(d.values) ? d.values : []).map((v) => num(v) ?? null),
        });
      }
    } else if (item.type === "google_trends_queries_list") {
      const data = obj(item.data);
      out.top.push(...queries(data.top));
      out.rising.push(...queries(data.rising));
    }
  }
  return out;
}

export const ADS_VOLUME_ENDPOINT = "keywords_data/google_ads/search_volume/live";
export const TRENDS_EXPLORE_ENDPOINT = "keywords_data/google_trends/explore/live";

/**
 * Rough list prices for a dry run (Nov 2026), in USD per call. The real price comes back with
 * each call and is what the ledger counts.
 */
export const HISTORY_LIST_PRICE_USD = { ads: 0.075, trends: 0.012 };

/** The Google Ads calls for these keywords: deduped, sorted, refused ones out, 1000 a call. */
export function adsHistoryPayloads(keywords: string[], market: Market, dateFrom: string) {
  const ok = [...new Set(keywords.map((k) => k.toLowerCase().trim()))].filter(adsAccepts).sort();
  const out: {
    keywords: string[];
    location_code: number;
    language_code: string;
    date_from: string;
  }[] = [];
  for (let i = 0; i < ok.length; i += 1000) {
    out.push({ keywords: ok.slice(i, i + 1000), ...marketParams(market), date_from: dateFrom });
  }
  return out;
}

/** One Google Trends explore call: up to 5 keywords, five years, curve and related searches. */
export function trendsPayload(keywords: string[], market: Market) {
  return {
    keywords: keywords.slice(0, 5),
    location_code: marketParams(market).location_code,
    language_code: market.language,
    type: "web",
    time_range: "past_5_years",
    item_types: ["google_trends_graph", "google_trends_queries_list"],
  };
}

/** What a signals run would buy: calls not in the cache yet, per endpoint. */
export function historyPlan(
  cache: FileCache,
  input: { keywords: string[]; topics: string[]; market: Market; dateFrom: string },
): {
  ads: { calls: number; toBuy: number };
  trends: { calls: number; toBuy: number };
  estimateUsd: number;
} {
  const ads = adsHistoryPayloads(input.keywords, input.market, input.dateFrom);
  const trends = input.topics.map((t) => trendsPayload([t], input.market));
  const missing = (endpoint: string, ps: object[]) =>
    ps.filter((p) => !cache.has(requestHash(endpoint, p))).length;
  const a = missing(ADS_VOLUME_ENDPOINT, ads);
  const t = missing(TRENDS_EXPLORE_ENDPOINT, trends);
  return {
    ads: { calls: ads.length, toBuy: a },
    trends: { calls: trends.length, toBuy: t },
    estimateUsd:
      Math.round((a * HISTORY_LIST_PRICE_USD.ads + t * HISTORY_LIST_PRICE_USD.trends) * 10000) /
      10000,
  };
}
