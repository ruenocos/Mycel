import { join } from "node:path";
import type { Market } from "@mycel/schema";
import { FileCache, requestHash } from "./cache.ts";
import { SpendLedger } from "./ledger.ts";
import { type DfsLocation, findCity, type MarketParams, marketParams } from "./locations.ts";
import { PENDING_MAX_AGE_MS, PendingTasks } from "./pending.ts";

/**
 * What a batch of SERPs would cost, counted without buying or fetching anything. It reads the
 * same cache, saved tasks and spend ledger as `DataforseoClient.serpOrganicBatch`, and builds the
 * same request hashes, so "in cache" here is exactly what that call will find. No network, no
 * writes: safe to run with paid calls off and without a login.
 */

export const SERP_TASK_ENDPOINT = "serp/google/organic/task_post";

/** DataforSEO's standard-queue price per SERP, used only until this cache has paid for one. */
export const SERP_LIST_PRICE_USD = 0.0006;

export interface SerpTaskOptions {
  depth?: number;
  device?: "desktop" | "mobile";
}

/** The request for one SERP. One function, so the plan and the real call hash the same thing. */
export function serpTaskPayload(
  keyword: string,
  where: MarketParams,
  opts: SerpTaskOptions = {},
): Record<string, unknown> {
  return { keyword, ...where, device: opts.device ?? "desktop", depth: opts.depth ?? 10 };
}

export interface SerpPlan {
  /** Unique keywords asked for. */
  total: number;
  /** Already in the cache: free. */
  cached: number;
  /** Paid for by an earlier run that stopped before the result came in: collected for free. */
  waiting: number;
  toBuy: number;
  /** Price per SERP the estimate uses. */
  priceUsd: number;
  /** Where that price comes from: the last SERP this cache paid for, or DataforSEO's list price. */
  priceSource: "paid before" | "list price";
  estimateUsd: number;
  /**
   * False when the market has a city whose location code isn't known yet (the free location
   * list was never fetched into this cache). Every SERP then counts as "to buy": an upper bound.
   */
  exact: boolean;
  /** USD already spent this calendar month through this cache (0 when nothing was recorded). */
  spentThisMonthUsd: number;
}

/** The city's SERP location when the location list is cached; null when it has to be fetched. */
function cachedSerpParams(cache: FileCache, market: Market): MarketParams | null {
  const country = marketParams(market);
  if (!market.city) return country;
  const endpoint = `serp/google/locations/${market.country.toLowerCase()}`;
  const locations = cache.get<DfsLocation[]>(requestHash(endpoint, {}))?.result;
  if (!locations) return null;
  const { match } = findCity(locations, market);
  // Not found or ambiguous: the real call falls back to the country too.
  return match ? { ...country, location_code: match.location_code } : country;
}

/** USD spent this calendar month through this cache, read without touching the ledger. */
export function monthSpendUsd(cacheDir: string, now: Date = new Date()): number {
  const entries = SpendLedger.read(join(cacheDir, "ledger"), now.toISOString().slice(0, 7));
  return Math.round(entries.reduce((sum, e) => sum + (e.costUsd || 0), 0) * 1e6) / 1e6;
}

export function planSerpBatch(
  cacheDir: string,
  keywords: string[],
  market: Market,
  opts: SerpTaskOptions & { now?: () => Date } = {},
): SerpPlan {
  const now = opts.now ?? (() => new Date());
  const cache = new FileCache(cacheDir);
  const tasks = new PendingTasks(join(cacheDir, "pending"));
  const unique = [...new Set(keywords)];
  const where = cachedSerpParams(cache, market);
  let cached = 0;
  let waiting = 0;
  if (where) {
    for (const keyword of unique) {
      const hash = requestHash(SERP_TASK_ENDPOINT, serpTaskPayload(keyword, where, opts));
      if (cache.has(hash)) {
        cached += 1;
        continue;
      }
      const task = tasks.get(hash);
      if (task && now().getTime() - Date.parse(task.postedAt) <= PENDING_MAX_AGE_MS) waiting += 1;
    }
  }
  const toBuy = unique.length - cached - waiting;
  const ledgerDir = join(cacheDir, "ledger");
  const last = SpendLedger.lastCost(ledgerDir, SERP_TASK_ENDPOINT);
  const priceUsd = last ?? SERP_LIST_PRICE_USD;
  return {
    total: unique.length,
    cached,
    waiting,
    toBuy,
    priceUsd,
    priceSource: last === undefined ? "list price" : "paid before",
    estimateUsd: Math.round(toBuy * priceUsd * 1e6) / 1e6,
    exact: where !== null,
    spentThisMonthUsd: monthSpendUsd(cacheDir, now()),
  };
}
