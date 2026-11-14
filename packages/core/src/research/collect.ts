import {
  ClientContext,
  type CompetitorCandidate,
  type Market,
  normalizeQuery,
  type Query,
  type QuerySource,
  ResearchDataset,
  ResearchSeed,
  type SerpSnapshot,
  SitePage,
  type SourceReport,
} from "@mycel/schema";
import { z } from "zod";
import { defineStep } from "../step.ts";

/**
 * Koray steps 7-8 (issue #16): gather every query the data sources know around the seeds, the
 * SERPs of the seeds (PAA, related searches, AI Overview references), the client's own GSC
 * queries and the queries competitors rank for. Competitors are found two ways: DataforSEO's
 * keyword overlap (misses small specialists when the client ranks for little) and who keeps
 * showing up in the top 10 of the seed SERPs (finds them). Nothing is filtered here; step 9 does.
 */

export const RESEARCH_VERSION = "2";

/* What core needs from a keyword data provider. DataforseoClient satisfies it structurally. */
export interface KeywordIdeaLike {
  keyword: string;
  volume?: number;
  cpc?: number;
  competition?: number;
  intent?: string;
  detectedLanguage?: string;
}
export interface RankedKeywordLike extends KeywordIdeaLike {
  position?: number;
  url?: string;
}
export interface SerpLike {
  keyword: string;
  organic: {
    rank: number;
    title: string;
    key: string;
    /** How far `key` can be trusted (ADR 0010). */
    urlSource?: "url" | "breadcrumb" | "domain";
    url: string | null;
    domain: string | null;
  }[];
  aiOverview: { present: boolean; references: { url: string; domain: string | null }[] };
  peopleAlsoAsk: string[];
  relatedSearches: string[];
  unresolvedUrls?: number;
}
// biome-ignore lint/suspicious/noExplicitAny: the recorder shape belongs to connectors; core passes its StepContext
type Rec = any;
export interface ResearchPort {
  relatedKeywords(seed: string, market: Market, rec: Rec): Promise<KeywordIdeaLike[]>;
  keywordSuggestions(seed: string, market: Market, rec: Rec): Promise<KeywordIdeaLike[]>;
  rankedKeywords(target: string, market: Market, rec: Rec): Promise<RankedKeywordLike[]>;
  competitorDomains(
    target: string,
    market: Market,
    rec: Rec,
  ): Promise<{ domain: string; intersections?: number }[]>;
  serpOrganic(keyword: string, market: Market, rec: Rec): Promise<SerpLike>;
}

/**
 * Sites that rank for almost anything. They stay in the list (marked) but are never mined.
 * Generic, not client-specific (CLAUDE.md).
 */
export const PLATFORM_DOMAINS = [
  "wikipedia.org",
  "youtube.com",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "reddit.com",
  "quora.com",
  "pinterest.com",
  "indeed.com",
  "glassdoor.com",
  "medium.com",
  "google.com",
  "apple.com",
] as const;

export const cleanDomain = (d: string) =>
  d
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");

/** A bare host ("bol.com"); SERP display names ("intratuin") can't be looked up. */
export const isHostName = (d: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d);

export const isPlatform = (domain: string) =>
  PLATFORM_DOMAINS.some((p) => domain === p || domain.endsWith(`.${p}`));

/** Reserved test TLDs (RFC 2606): no search data exists, so don't pay to ask. */
export const isReservedHost = (host: string) => /\.(example|test|invalid|localhost)$/.test(host);

const INTENTS = new Set(["informational", "commercial", "transactional", "navigational", "local"]);

/** Dedupes on the normalized text; merges sources and fills metrics that are still empty. */
export class QueryBag {
  private readonly map = new Map<string, Query>();

  add(
    text: string,
    source: QuerySource,
    extra: {
      idea?: KeywordIdeaLike;
      gsc?: { clicks: number; impressions: number; position: number };
    } = {},
  ): void {
    const normalized = normalizeQuery(text);
    if (!normalized) return;
    let q = this.map.get(normalized);
    if (!q) {
      q = { text: text.trim(), normalized, sources: [], metrics: {} };
      this.map.set(normalized, q);
    }
    if (!q.sources.includes(source)) q.sources.push(source);
    const m = q.metrics;
    const idea = extra.idea;
    if (idea) {
      if (m.volume === undefined && idea.volume !== undefined) m.volume = Math.round(idea.volume);
      if (m.cpc === undefined && idea.cpc !== undefined) m.cpc = idea.cpc;
      if (m.competition === undefined && idea.competition !== undefined) {
        m.competition = Math.min(1, Math.max(0, idea.competition));
      }
      if (!q.intent && idea.intent && INTENTS.has(idea.intent)) {
        q.intent = idea.intent as Query["intent"];
      }
      if (!q.language && idea.detectedLanguage) q.language = idea.detectedLanguage;
    }
    if (extra.gsc) {
      m.gscClicks = Math.round(extra.gsc.clicks);
      m.gscImpressions = Math.round(extra.gsc.impressions);
      if (extra.gsc.position > 0) m.gscPosition = extra.gsc.position;
    }
  }

  get size(): number {
    return this.map.size;
  }

  list(): Query[] {
    return [...this.map.values()];
  }
}

/** Runs `fn` over items with at most `n` in flight; results keep the input order. */
export async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** Counts in how many SERPs each domain shows up in the top 10 (once per SERP). */
export function serpDomainCounts(serps: SerpLike[], ownHost: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of serps) {
    const seen = new Set<string>();
    for (const o of s.organic) {
      if (o.rank > 10 || !o.domain) continue;
      const d = cleanDomain(o.domain);
      if (!isHostName(d) || d === ownHost || d.endsWith(`.${ownHost}`) || seen.has(d)) continue;
      seen.add(d);
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  return counts;
}

export interface CompetitorInputs {
  context: string[];
  labs: { domain: string; intersections?: number }[];
  serpCounts: Map<string, number>;
}

/**
 * Merges the three competitor sources and picks which ones to mine: every confirmed competitor,
 * then non-platform domains that appear in at least `minSerps` seed SERPs, most appearances first,
 * then Labs overlap. Capped at `maxMined`.
 */
export function rankCompetitors(
  inputs: CompetitorInputs,
  opts: { minSerps: number; maxMined: number },
): CompetitorCandidate[] {
  const byDomain = new Map<string, CompetitorCandidate>();
  const get = (raw: string) => {
    const domain = cleanDomain(raw);
    let c = byDomain.get(domain);
    if (!c) {
      c = {
        domain,
        sources: [],
        serpAppearances: inputs.serpCounts.get(domain) ?? 0,
        platform: isPlatform(domain),
        inContext: false,
        mined: false,
      };
      byDomain.set(domain, c);
    }
    return c;
  };
  for (const d of inputs.context) {
    const c = get(d);
    c.inContext = true;
    if (!c.sources.includes("context")) c.sources.push("context");
  }
  for (const l of inputs.labs) {
    const c = get(l.domain);
    if (!c.sources.includes("labs")) c.sources.push("labs");
    if (l.intersections !== undefined) c.sharedKeywords = Math.round(l.intersections);
  }
  for (const [d, n] of inputs.serpCounts) {
    if (n < opts.minSerps) continue;
    const c = get(d);
    if (!c.sources.includes("serp")) c.sources.push("serp");
  }
  const all = [...byDomain.values()].sort(
    (a, b) =>
      Number(b.inContext) - Number(a.inContext) ||
      b.serpAppearances - a.serpAppearances ||
      (b.sharedKeywords ?? 0) - (a.sharedKeywords ?? 0) ||
      a.domain.localeCompare(b.domain),
  );
  let mined = 0;
  for (const c of all) {
    if (mined >= opts.maxMined) break;
    const eligible =
      isHostName(c.domain) && (c.inContext || (!c.platform && c.serpAppearances >= opts.minSerps));
    if (!eligible) continue;
    c.mined = true;
    mined++;
  }
  return all;
}

export const ResearchOptions = z.object({
  /** Fetch SERPs for the seeds (paid unless cached). */
  serps: z.boolean().default(true),
  /** Pull ranked keywords for the client and competitors. */
  ranked: z.boolean().default(true),
  /** A domain must appear in this many seed SERPs to count as a competitor. */
  minSerps: z.number().int().positive().default(2),
  maxCompetitorsMined: z.number().int().nonnegative().default(8),
  serpConcurrency: z.number().int().positive().default(4),
});
export type ResearchOptions = z.infer<typeof ResearchOptions>;

export const ResearchInput = z.object({
  context: ClientContext,
  seeds: z.array(ResearchSeed).min(1),
  pages: z.array(SitePage.pick({ url: true, kind: true, title: true, h1: true })).default([]),
  gscRows: z
    .array(
      z.object({
        query: z.string(),
        clicks: z.number(),
        impressions: z.number(),
        position: z.number(),
      }),
    )
    .optional(),
  options: ResearchOptions.default(ResearchOptions.parse({})),
});
export type ResearchInput = z.input<typeof ResearchInput>;

const isBlockedSerp = (err: unknown) => (err as Error)?.name === "LiveCallBlockedError";

export function researchStep(port: ResearchPort) {
  return defineStep({
    name: "research-collect",
    version: RESEARCH_VERSION,
    input: ResearchInput,
    output: ResearchDataset,
    async run(input, ctx) {
      const { context, seeds, options } = input;
      const market = context.market;
      const host = cleanDomain(new URL(context.site.url).hostname);
      const reserved = isReservedHost(host);
      const bag = new QueryBag();
      const coverage: SourceReport[] = [];
      const warnings: string[] = [];
      const report = (source: string, calls: number, items: number, note?: string) => {
        coverage.push({ source, calls, items, ...(note ? { note } : {}) });
        ctx.log.info(`research source ${source}`, { calls, items, note: note ?? null });
      };

      for (const s of seeds) bag.add(s.text, "seed");

      // Labs keyword ideas around every seed. Sequential, so the budget check is exact.
      // One seed the API keeps refusing (e.g. a steady HTTP 500) shouldn't throw away the run;
      // the budget still stops it, and a source that fails for every seed stops it too.
      const ideas = async (
        source: "dfs_related" | "dfs_suggestions",
        call: (seed: string) => Promise<KeywordIdeaLike[]>,
      ) => {
        let items = 0;
        const failed: string[] = [];
        let last: unknown;
        for (const s of seeds) {
          let got: KeywordIdeaLike[];
          try {
            got = await call(s.text);
          } catch (err) {
            if ((err as Error)?.name === "BudgetExceededError") throw err;
            ctx.log.warn(`${source} failed for a seed, skipping it`, {
              seed: s.text,
              error: (err as Error)?.message ?? String(err),
            });
            failed.push(s.text);
            last = err;
            continue;
          }
          for (const k of got) {
            bag.add(k.keyword, source, { idea: k });
            items++;
          }
        }
        if (seeds.length > 0 && failed.length === seeds.length) throw last;
        if (failed.length > 0) {
          warnings.push(`${source} failed for ${failed.length} seed(s): ${failed.join(", ")}.`);
        }
        report(
          source,
          seeds.length,
          items,
          failed.length > 0 ? `failed for ${failed.join(", ")}` : undefined,
        );
      };
      await ideas("dfs_related", (seed) => port.relatedKeywords(seed, market, ctx));
      await ideas("dfs_suggestions", (seed) => port.keywordSuggestions(seed, market, ctx));

      // The client's own ranked keywords.
      if (options.ranked && !reserved) {
        const own = await port.rankedKeywords(host, market, ctx);
        for (const k of own) bag.add(k.keyword, "dfs_ranked_site", { idea: k });
        report("dfs_ranked_site", 1, own.length);
      } else {
        report("dfs_ranked_site", 0, 0, reserved ? "test domain: no search data" : "turned off");
      }

      // GSC, when the client connected it.
      if (input.gscRows) {
        for (const r of input.gscRows) {
          bag.add(r.query, "gsc", {
            gsc: { clicks: r.clicks, impressions: r.impressions, position: r.position },
          });
        }
        report("gsc", 1, input.gscRows.length);
      } else {
        report("gsc", 0, 0, "not connected");
        warnings.push(
          "No Search Console data: the map can't see which queries already bring impressions.",
        );
      }

      // Seed SERPs: PAA, related searches, AI Overview references, and who ranks.
      const serps: SerpLike[] = [];
      if (options.serps) {
        let blocked = 0;
        const got = await pool(seeds, options.serpConcurrency, async (s) => {
          try {
            return await port.serpOrganic(s.text, market, ctx);
          } catch (err) {
            if (!isBlockedSerp(err)) throw err;
            blocked++;
            ctx.log.warn("seed SERP skipped: not cached and live SERPs are off", {
              seed: s.text,
            });
            return null;
          }
        });
        for (const s of got) if (s) serps.push(s);
        let paa = 0;
        let rel = 0;
        for (const s of serps) {
          for (const q of s.peopleAlsoAsk) {
            bag.add(q, "serp_paa");
            paa++;
          }
          for (const q of s.relatedSearches) {
            bag.add(q, "serp_related");
            rel++;
          }
        }
        // Results known by domain only can't prove two queries share a page (ADR 0010).
        const organic = serps.flatMap((s) => s.organic);
        const domainOnly = organic.filter((o) => o.urlSource === "domain").length;
        const notes = [
          ...(blocked ? [`${blocked} skipped: not cached, live SERPs off`] : []),
          ...(domainOnly
            ? [`${domainOnly} of ${organic.length} results known by domain only`]
            : []),
        ];
        report("serp", seeds.length - blocked, serps.length, notes.join("; ") || undefined);
        report("serp_paa", 0, paa);
        report("serp_related", 0, rel);
        if (blocked) {
          warnings.push(
            `${blocked} of ${seeds.length} seed SERPs were skipped (not cached; run with --live-serp). Competitor discovery and PAA are incomplete.`,
          );
        }
      } else {
        report("serp", 0, 0, "turned off");
      }

      // Competitors: confirmed, Labs overlap, and SERP presence.
      let labs: { domain: string; intersections?: number }[] = [];
      if (options.ranked && !reserved) {
        labs = (await port.competitorDomains(host, market, ctx)).filter(
          (c) => cleanDomain(c.domain) !== host,
        );
        report("dfs_competitors", 1, labs.length);
      }
      const competitors = rankCompetitors(
        { context: context.competitors, labs, serpCounts: serpDomainCounts(serps, host) },
        { minSerps: options.minSerps, maxMined: options.ranked ? options.maxCompetitorsMined : 0 },
      );
      let compKeywords = 0;
      const mined = competitors.filter((c) => c.mined);
      const failedDomains: string[] = [];
      for (const c of mined) {
        let ranked: RankedKeywordLike[];
        try {
          ranked = await port.rankedKeywords(c.domain, market, ctx);
        } catch (err) {
          // One bad competitor shouldn't throw away a whole run; the budget still stops it.
          if ((err as Error)?.name === "BudgetExceededError") throw err;
          ctx.log.warn("competitor ranked keywords failed, skipping it", {
            domain: c.domain,
            error: (err as Error).message,
          });
          c.mined = false;
          failedDomains.push(c.domain);
          continue;
        }
        for (const k of ranked) {
          bag.add(k.keyword, "dfs_ranked_competitor", { idea: k });
          compKeywords++;
        }
      }
      report(
        "dfs_ranked_competitor",
        mined.length,
        compKeywords,
        failedDomains.length ? `failed: ${failedDomains.join(", ")}` : undefined,
      );
      if (failedDomains.length) {
        warnings.push(
          `Couldn't get ranked keywords for ${failedDomains.join(", ")} (see the run log).`,
        );
      }
      const suggested2 = competitors.filter((c) => !c.inContext && c.mined).map((c) => c.domain);
      if (suggested2.length) {
        ctx.log.info("competitors found that aren't in the context", { domains: suggested2 });
      }

      return {
        site: context.site,
        market,
        seeds,
        queries: bag.list(),
        serps: serps.map(
          (s): SerpSnapshot => ({
            keyword: s.keyword,
            organic: s.organic.map((o) => ({
              rank: o.rank,
              key: o.key,
              ...(o.urlSource ? { urlSource: o.urlSource } : {}),
              url: o.url,
              domain: o.domain ? cleanDomain(o.domain) : null,
              title: o.title,
            })),
            aiOverview: {
              present: s.aiOverview.present,
              references: s.aiOverview.references.map((r) => ({ url: r.url, domain: r.domain })),
            },
            peopleAlsoAsk: s.peopleAlsoAsk,
            relatedSearches: s.relatedSearches,
            ...(s.unresolvedUrls !== undefined ? { unresolvedUrls: s.unresolvedUrls } : {}),
          }),
        ),
        competitors,
        pages: input.pages,
        coverage,
        warnings,
      };
    },
  });
}
