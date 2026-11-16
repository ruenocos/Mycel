import { z } from "zod";
import { Market } from "./context.ts";

/**
 * Map signals (issue #63): what the open Koray map steps add before the map is built. The map
 * reads this file when it is there; without it the map is built as before.
 *
 * - Step 14, trends: how searches move over the year and between years, and what is rising.
 * - Steps 8 and 11, competitors: their sitemaps give their size (vastness), how many pages they
 *   have per topic (depth) and how often they change pages (momentum), plus topics they write
 *   about that have no search in the research yet (gaps).
 */

const Month = z.string().regex(/^\d{4}-\d{2}$/, "YYYY-MM");
export const MonthPoint = z.object({ month: Month, volume: z.number().int().nonnegative() });
export type MonthPoint = z.infer<typeof MonthPoint>;

const MonthOfYear = z.number().int().min(1).max(12);

/**
 * rising / falling: at least 30% more or less than a year earlier. seasonal: a clear peak in
 * some months. steady: none of these. A page without enough history gets no trend at all.
 */
export const TrendLabel = z.enum(["rising", "falling", "seasonal", "steady"]);
export type TrendLabel = z.infer<typeof TrendLabel>;

export const ClusterTrend = z.object({
  clusterId: z.string().min(1),
  mainQuery: z.string().min(1),
  label: TrendLabel,
  /** Change against a year earlier as a fraction (0.4 = 40% more), when the data reaches back. */
  change: z.number().optional(),
  /** Months that clearly peak (1-12). */
  peakMonths: z.array(MonthOfYear).default([]),
  /** For a seasonal page: the month to publish by, two months before its first peak. */
  publishBy: MonthOfYear.optional(),
  /** Google Trends listed one of its searches as rising. */
  risingInTrends: z.boolean().default(false),
  /** Monthly searches, summed over the cluster's searches, oldest first (at most 24). */
  monthly: z.array(MonthPoint).default([]),
});
export type ClusterTrend = z.infer<typeof ClusterTrend>;

/** The long curve of a topic (central entity, top offering) from Google Trends. */
export const TopicTrend = z.object({
  keyword: z.string().min(1),
  label: TrendLabel,
  /** Last 12 months against the 12 before, as a fraction. */
  change: z.number().optional(),
  peakMonths: z.array(MonthOfYear).default([]),
});
export type TopicTrend = z.infer<typeof TopicTrend>;

/** A rising search from Google Trends that the research has no page for. */
export const TrendIdea = z.object({
  query: z.string().min(1),
  /** Growth in percent as Google Trends gives it; "Breakout" comes as 5000 or more. */
  growthPct: z.number(),
  /** The topic it rose under. */
  under: z.string().min(1),
});
export type TrendIdea = z.infer<typeof TrendIdea>;

export const TrendSignals = z.object({
  clusters: z.array(ClusterTrend),
  topics: z.array(TopicTrend).default([]),
  ideas: z.array(TrendIdea).default([]),
  /** Page clusters, and how many had enough history for a trend. */
  coverage: z.object({
    clusters: z.number().int().nonnegative(),
    withTrend: z.number().int().nonnegative(),
  }),
});
export type TrendSignals = z.infer<typeof TrendSignals>;

export const CompetitorSite = z.object({
  domain: z.string().min(1),
  status: z.enum(["ok", "blocked", "missing"]),
  reason: z.string().optional(),
  /** Content pages in its sitemaps (step 11, vastness). */
  pages: z.number().int().nonnegative(),
  /** The sitemap stopped at the cap: the site has more. */
  truncated: z.boolean().default(false),
  /** Its biggest folders. */
  sections: z.array(z.object({ folder: z.string(), pages: z.number().int().nonnegative() })),
  /**
   * Pages changed per month over the last 12 months, from the sitemap's last-modified dates
   * (step 11, momentum). A change is not always a new page.
   */
  changesPerMonth: z.array(MonthPoint).default([]),
  /** Average of the above. */
  perMonth: z.number().nonnegative().default(0),
  /** Share of its pages with a last-modified date (0-1): how far the momentum can be trusted. */
  dated: z.number().min(0).max(1).default(0),
});
export type CompetitorSite = z.infer<typeof CompetitorSite>;

/** Competitors with a page on one cluster's topic (step 11, depth). */
export const ClusterCoverage = z.object({
  clusterId: z.string().min(1),
  competitors: z.array(z.string().min(1)),
  /** A few of their URLs, as proof. */
  urls: z.array(z.string()).default([]),
});
export type ClusterCoverage = z.infer<typeof ClusterCoverage>;

/** A topic two or more competitors have pages on, with no search for it in the research (step 8). */
export const GapTopic = z.object({
  topic: z.string().min(1),
  competitors: z.array(z.string().min(1)).min(2),
  pages: z.number().int().positive(),
  urls: z.array(z.string()).default([]),
});
export type GapTopic = z.infer<typeof GapTopic>;

export const CompetitorSignals = z.object({
  sites: z.array(CompetitorSite),
  coverage: z.array(ClusterCoverage),
  gaps: z.array(GapTopic).default([]),
});
export type CompetitorSignals = z.infer<typeof CompetitorSignals>;

export const SignalSet = z.object({
  site: z.object({ url: z.url(), name: z.string().min(1) }),
  market: Market,
  createdAt: z.iso.datetime(),
  trends: TrendSignals.optional(),
  competitors: CompetitorSignals.optional(),
  warnings: z.array(z.string()).default([]),
});
export type SignalSet = z.infer<typeof SignalSet>;
