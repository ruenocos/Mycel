import { z } from "zod";

/** Where the client competes. Used in every DataforSEO call; never hardcoded (CLAUDE.md). */
export const Market = z.object({
  /** ISO 3166-1 alpha-2, e.g. "NL". */
  country: z.string().regex(/^[A-Z]{2}$/),
  /** ISO 639-1, e.g. "nl". */
  language: z.string().regex(/^[a-z]{2}$/),
  /** Optional city for local businesses, e.g. "Utrecht". */
  city: z.string().min(1).optional(),
});
export type Market = z.infer<typeof Market>;

/** A central entity with its meaning pinned down, e.g. ERP = Enterprise Resource Planning (not Erp the village). */
export const CentralEntity = z.object({
  name: z.string().min(1),
  disambiguation: z.string().min(1),
  /** Things that look like this entity but are not, used by the noise filter (step 9). */
  notThis: z.array(z.string().min(1)).default([]),
});
export type CentralEntity = z.infer<typeof CentralEntity>;

/** One of the client questions from Koray steps 1-6: proposed by Mycel, confirmed by a human. */
export const ContextAnswer = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
  status: z.enum(["proposed", "confirmed", "edited"]),
  /** Where the proposal came from, so a human can judge it. */
  evidence: z.array(z.string()).default([]),
});
export type ContextAnswer = z.infer<typeof ContextAnswer>;

/** Output of steps 1-6. Everything client-specific lives here, not in code. */
export const ClientContext = z.object({
  site: z.object({
    url: z.url(),
    name: z.string().min(1),
  }),
  market: Market,
  /** How the site earns money; the lens for every node (Koray: source context). */
  sourceContext: z.string().min(1),
  /** One or more: a site can have several maps (De Saak: ERP and document scanning). */
  centralEntities: z.array(CentralEntity).min(1),
  centralSearchIntent: z.string().min(1),
  audiences: z.array(z.string().min(1)).default([]),
  offerings: z.array(z.string().min(1)).default([]),
  /** Competitor domains, e.g. "afas.nl". */
  competitors: z.array(z.string().min(1)).default([]),
  answers: z.array(ContextAnswer).default([]),
  confirmed: z
    .object({
      by: z.string().min(1),
      at: z.iso.datetime(),
    })
    .optional(),
});
export type ClientContext = z.infer<typeof ClientContext>;

/**
 * Everything Mycel looked at before proposing a context (steps 1-6). Each item has an id the
 * proposal cites as evidence, so a human can check where an answer came from.
 */
export const ContextEvidence = z.object({
  site: z.object({ url: z.url(), name: z.string().min(1) }),
  pages: z
    .array(
      z.object({
        id: z.string().min(1),
        url: z.string().startsWith("/"),
        kind: z.string().min(1),
        title: z.string().min(1),
        h1: z.string().min(1),
        metaDescription: z.string().optional(),
        /** Body text, only for the pages that say most about the business. */
        text: z.string().optional(),
      }),
    )
    .min(1),
  /** Top Search Console queries, when the client connected GSC. */
  gscQueries: z
    .array(z.object({ query: z.string(), clicks: z.number(), impressions: z.number() }))
    .default([]),
  /** Queries the domain already ranks for (DataforSEO Labs). */
  rankedKeywords: z
    .array(
      z.object({
        keyword: z.string(),
        position: z.number().optional(),
        volume: z.number().optional(),
        url: z.string().optional(),
      }),
    )
    .default([]),
  /** Domains that rank for the same queries (DataforSEO Labs). */
  competitorDomains: z
    .array(z.object({ domain: z.string(), sharedKeywords: z.number().optional() }))
    .default([]),
});
export type ContextEvidence = z.infer<typeof ContextEvidence>;
