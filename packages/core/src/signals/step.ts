import {
  ClientContext,
  ClusterSet,
  CompetitorCandidate,
  FilteredQuery,
  type Market,
  SignalSet,
} from "@mycel/schema";
import { z } from "zod";
import type { JsonModel } from "../context/llm.ts";
import { cleanDomain } from "../research/collect.ts";
import { defineStep } from "../step.ts";
import {
  clusterCoverage,
  gapTopics,
  pickCompetitors,
  type SitemapLike,
  siteSignals,
} from "./competitors.ts";
import {
  buildGlossary,
  type EntityLike,
  entityCheck,
  type HitLike,
  pickExact,
  pickItems,
  termCandidates,
  type WikidataPort,
} from "./glossary.ts";
import { GLOSSARY, TRENDS } from "./rules.ts";
import { buildTrends, type ExploreLike, type HistoryLike } from "./trends.ts";

/**
 * The signals step (issue #63): the open Koray map steps, as data the map reads.
 *
 * - Step 14: monthly searches per page (cached Labs data, then Google Ads for 24 months) and
 *   Google Trends for the central entity and the top offerings.
 * - Steps 8 and 11: competitors' sitemaps.
 * - Steps 3 and 7: the central entity and the domain's terms against Wikidata (glossary).
 *
 * Paid calls (Google Ads volume, Google Trends) are cached and counted against the run budget;
 * sitemaps are free. A source that fails is a warning in the file, never a silent gap.
 */

/**
 * 1: trends (step 14) and competitor sitemaps (steps 8, 11).
 * 2: central entity check and glossary from Wikidata (steps 3, 7; wikidata-pick v1).
 */
export const SIGNALS_VERSION = "2";

// biome-ignore lint/suspicious/noExplicitAny: the recorder shape belongs to connectors; core passes its StepContext
type Rec = any;

/** What core needs for trends. DataforseoClient satisfies it structurally. */
export interface TrendsPort {
  cachedKeywordHistories(): Map<string, HistoryLike>;
  keywordHistory(
    keywords: string[],
    market: Market,
    rec: Rec,
    opts: { dateFrom: string },
  ): Promise<HistoryLike[]>;
  trendsExplore(keywords: string[], market: Market, rec: Rec): Promise<ExploreLike>;
}

/** What core needs to read a sitemap. SitemapReader satisfies it. */
export interface SitemapPort {
  read(domain: string, rec: Rec): Promise<SitemapLike>;
}

export const SignalsInput = z.object({
  context: ClientContext,
  clusters: ClusterSet,
  queries: z.array(FilteredQuery).default([]),
  /** The research's competitor candidates (research.json). */
  competitors: z.array(CompetitorCandidate).default([]),
  /** The run's date, for "the last 12 months" (tests pass one). */
  now: z.iso.datetime().optional(),
  /** Google Ads monthly searches for page searches the cache has no history for. */
  adsHistory: z.boolean().default(true),
  /** Google Trends for the central entity and the top offerings. */
  explore: z.boolean().default(true),
  sitemaps: z.boolean().default(true),
  /** The central entity and the glossary against Wikidata (free). */
  wikidata: z.boolean().default(true),
  /** The model that picks which Wikidata item a term means; without one, exact names only. */
  model: z.string().min(1).optional(),
});
export type SignalsInput = z.input<typeof SignalsInput>;

/** The first day of the month `back` months before `now` (YYYY-MM-DD). */
export const monthStart = (now: Date, back: number) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  return d.toISOString().slice(0, 10);
};

/** Searches of the page clusters: what the trends need a history for. */
export const pageSearches = (clusters: ClusterSet) => [
  ...new Set(
    clusters.clusters
      .filter((c) => c.qdp === "page")
      .flatMap((c) => c.queries.map((q) => q.toLowerCase().trim())),
  ),
];

/** The topics Google Trends is asked about: central entities, then the top offerings. */
export function trendTopics(context: ClientContext): string[] {
  const b = context.business;
  const offerings = b
    ? [
        ...b.offerings.filter((o) => o.value === "top"),
        ...b.offerings.filter((o) => o.value !== "top"),
      ].map((o) => o.name)
    : context.offerings;
  const names = [...context.centralEntities.map((e) => e.name), ...offerings].map((n) =>
    n.toLowerCase().trim(),
  );
  return [...new Set(names)].filter(Boolean).slice(0, TRENDS.maxTopics);
}

/** A budget or a blocked paid call stops the run; anything else is a warning. */
const fatal = (err: unknown) =>
  err instanceof Error && /BudgetExceeded|LiveCallBlocked/.test(err.name || err.constructor.name);

export function signalsStep(ports: {
  keywords?: TrendsPort;
  sitemaps?: SitemapPort;
  wikidata?: WikidataPort;
  llm?: JsonModel;
}) {
  return defineStep({
    name: "signals",
    version: SIGNALS_VERSION,
    input: SignalsInput,
    output: SignalSet,
    async run(input, ctx) {
      const now = input.now ? new Date(input.now) : new Date();
      const { context, clusters } = input;
      const market = context.market;
      const warnings: string[] = [];
      const warn = (msg: string, err: unknown) => {
        if (fatal(err)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.warn(msg, { error: message });
        warnings.push(`${msg}: ${message}`);
      };
      const out: z.input<typeof SignalSet> = {
        site: clusters.site,
        market,
        createdAt: now.toISOString(),
        warnings,
      };

      if (ports.keywords) {
        const histories = new Map(ports.keywords.cachedKeywordHistories());
        if (input.adsHistory) {
          const wanted = pageSearches(clusters);
          try {
            const got = await ports.keywords.keywordHistory(wanted, market, ctx, {
              dateFrom: monthStart(now, 24),
            });
            for (const h of got) {
              const k = h.keyword.toLowerCase().trim();
              const had = histories.get(k);
              if (!had || h.monthly.length >= had.monthly.length) histories.set(k, h);
            }
          } catch (err) {
            warn("monthly searches from Google Ads failed, trends use cached data only", err);
          }
        }
        const explores: ExploreLike[] = [];
        if (input.explore) {
          for (const topic of trendTopics(context)) {
            try {
              explores.push(await ports.keywords.trendsExplore([topic], market, ctx));
            } catch (err) {
              warn(`Google Trends for "${topic}" failed`, err);
            }
          }
        }
        const t = buildTrends({
          clusters: clusters.clusters,
          histories,
          explores,
          language: market.language,
        });
        const pages = clusters.clusters.filter((c) => c.qdp === "page").length;
        out.trends = {
          clusters: t.clusters,
          topics: t.topics,
          ideas: t.ideas,
          coverage: { clusters: pages, withTrend: t.withTrend },
        };
        ctx.log.info("trends", {
          histories: histories.size,
          pages,
          withTrend: t.withTrend,
          rising: t.clusters.filter((c) => c.label === "rising").length,
          seasonal: t.clusters.filter((c) => c.peakMonths.length).length,
          ideas: t.ideas.length,
        });
      }

      if (ports.sitemaps && input.sitemaps) {
        const domains = pickCompetitors(context, input.competitors);
        const read: SitemapLike[] = [];
        for (const d of domains) {
          try {
            read.push(await ports.sitemaps.read(d, ctx));
          } catch (err) {
            warn(`sitemap of ${d} failed`, err);
          }
        }
        const sites = read.map((s) => {
          const r = siteSignals(s, now);
          if (r.warning) warnings.push(r.warning);
          if (s.status !== "ok")
            warnings.push(`${s.domain}: sitemap ${s.status}${s.reason ? ` (${s.reason})` : ""}`);
          return r.site;
        });
        out.competitors = {
          sites,
          coverage: clusterCoverage({
            clusters: clusters.clusters,
            sites: read,
            language: market.language,
            ...(market.city ? { city: market.city } : {}),
          }),
          gaps: gapTopics({
            sites: read,
            queries: input.queries,
            language: market.language,
            ownDomain: cleanDomain(context.site.url),
          }),
        };
        ctx.log.info("competitor sitemaps", {
          asked: domains,
          read: sites.filter((s) => s.status === "ok").length,
          pages: sites.map((s) => `${s.domain}:${s.pages}`),
          covered: out.competitors.coverage.length,
          gaps: out.competitors.gaps?.length ?? 0,
        });
      }
      if (ports.wikidata && input.wikidata) {
        const language = market.language;
        const terms = termCandidates(context, input.queries);
        const names = context.centralEntities.map((e) => e.name);
        const asked = [...new Set([...names, ...terms.map((t) => t.term)])];
        const items: { term: string; candidates: HitLike[] }[] = [];
        let failed = 0;
        let lastError: unknown;
        for (const term of asked) {
          try {
            const hits = await ports.wikidata.search(term, language, ctx);
            items.push({ term, candidates: hits.slice(0, GLOSSARY.candidates) });
          } catch (err) {
            failed++;
            lastError = err;
          }
        }
        if (failed)
          warn(`Wikidata search failed for ${failed} of ${asked.length} terms`, lastError);
        let picked = pickExact(items);
        if (ports.llm && input.model) {
          try {
            picked = await pickItems(ports.llm, context, items, { model: input.model }, ctx);
          } catch (err) {
            warn("the model could not match terms to Wikidata, exact names only", err);
          }
        }
        const entities = new Map<string, EntityLike>();
        const ids = [...new Set(picked.values())];
        if (ids.length) {
          try {
            for (const e of await ports.wikidata.entities(ids, language, ctx))
              entities.set(e.id, e);
          } catch (err) {
            warn("Wikidata entities could not be read", err);
          }
        }
        const reached = items.length > 0;
        out.entities = names.map((n) => {
          const id = picked.get(n);
          return entityCheck(n, id ? entities.get(id) : undefined, reached);
        });
        out.glossary = buildGlossary({ terms, picked, entities, queries: input.queries, language });
        ctx.log.info("wikidata", {
          terms: terms.length,
          searched: items.length,
          matched: picked.size,
          recognized: out.entities.filter((e) => e.recognized).map((e) => e.name),
        });
      }
      return out;
    },
  });
}
