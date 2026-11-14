import { z } from "zod";
import { Market } from "./context.ts";
import { Query } from "./query.ts";
import { SitePage } from "./site.ts";

/**
 * Koray steps 7-8 (issue #16): everything the data sources say about the client's topic, before
 * any filtering. Data first: every query carries the sources it came from; the model only adds
 * seed phrasings, never metrics or facts.
 */

/** Where a seed query came from. */
export const SeedBasis = z.enum(["entity", "offering", "gsc", "ranked", "model"]);
export type SeedBasis = z.infer<typeof SeedBasis>;

export const ResearchSeed = z.object({
  text: z.string().min(1),
  normalized: z.string().min(1),
  basis: SeedBasis,
  /** The entity or offering it was made from, when there is one. */
  ref: z.string().optional(),
});
export type ResearchSeed = z.infer<typeof ResearchSeed>;

/** Where a SERP result's overlap key came from (ADR 0010). */
export const SerpUrlSource = z.enum(["url", "breadcrumb", "domain"]);
export type SerpUrlSource = z.infer<typeof SerpUrlSource>;

/** One SERP, trimmed to what later steps use (clustering, PAA, AI Overview presence). */
export const SerpSnapshot = z.object({
  keyword: z.string().min(1),
  organic: z.array(
    z.object({
      rank: z.number().int().positive(),
      /** SERP-overlap key (ADR 0010). */
      key: z.string().min(1),
      /**
       * How far the key can be trusted (ADR 0010): the real URL, a path rebuilt from the
       * breadcrumb (may be cut off), or only the domain. Optional: datasets written before this
       * field existed don't have it.
       */
      urlSource: SerpUrlSource.optional(),
      url: z.string().nullable(),
      domain: z.string().nullable(),
      title: z.string(),
    }),
  ),
  aiOverview: z.object({
    present: z.boolean(),
    references: z.array(z.object({ url: z.string(), domain: z.string().nullable() })),
  }),
  peopleAlsoAsk: z.array(z.string()),
  relatedSearches: z.array(z.string()),
  /** Organic results whose real URL Google hid behind a redirect (ADR 0010). */
  unresolvedUrls: z.number().int().nonnegative().optional(),
});
export type SerpSnapshot = z.infer<typeof SerpSnapshot>;

export const CompetitorSource = z.enum(["context", "labs", "serp"]);

/** A domain competing for the client's queries, with why Mycel thinks so. */
export const CompetitorCandidate = z.object({
  domain: z.string().min(1),
  sources: z.array(CompetitorSource).min(1),
  /** In how many seed SERPs (top 10) the domain appears. */
  serpAppearances: z.number().int().nonnegative(),
  /** Keywords shared with the client's domain (DataforSEO Labs). */
  sharedKeywords: z.number().int().nonnegative().optional(),
  /** Generic platforms (Wikipedia, YouTube, LinkedIn, ...) rank everywhere and aren't real competitors. */
  platform: z.boolean(),
  /** Already in the confirmed context. False means: a suggestion for the person to confirm. */
  inContext: z.boolean(),
  /** Its ranked keywords were pulled into this dataset. */
  mined: z.boolean(),
});
export type CompetitorCandidate = z.infer<typeof CompetitorCandidate>;

/** What each source delivered, so a thin dataset can be traced to the source that came back empty. */
export const SourceReport = z.object({
  source: z.string().min(1),
  calls: z.number().int().nonnegative(),
  items: z.number().int().nonnegative(),
  note: z.string().optional(),
});
export type SourceReport = z.infer<typeof SourceReport>;

export const ResearchDataset = z
  .object({
    site: z.object({ url: z.url(), name: z.string().min(1) }),
    market: Market,
    seeds: z.array(ResearchSeed).min(1),
    /** Deduped on `normalized`; sources and metrics merged. */
    queries: z.array(Query).min(1),
    serps: z.array(SerpSnapshot),
    competitors: z.array(CompetitorCandidate),
    /** The client's existing pages: topics the site already covers (step 8). */
    pages: z.array(SitePage.pick({ url: true, kind: true, title: true, h1: true })),
    coverage: z.array(SourceReport),
    warnings: z.array(z.string()).default([]),
  })
  .superRefine((d, ctx) => {
    const seen = new Set<string>();
    for (const [i, q] of d.queries.entries()) {
      if (seen.has(q.normalized)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate query ${q.normalized}`,
          path: ["queries", i],
        });
      }
      seen.add(q.normalized);
    }
  });
export type ResearchDataset = z.infer<typeof ResearchDataset>;
