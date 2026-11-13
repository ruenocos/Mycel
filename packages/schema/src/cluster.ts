import { z } from "zod";

/** Output of step 10: queries grouped by SERP overlap (ADR 0003). */
export const Cluster = z.object({
  id: z.string().min(1),
  mainQuery: z.string().min(1),
  /** Normalized query texts, main query included. */
  queries: z.array(z.string().min(1)).min(1),
  /** Top-10 URLs shared by the cluster (normalized). */
  sharedUrls: z.array(z.string()).default([]),
  /**
   * Query Deserves a Page: a page of its own, a section on another cluster's page,
   * or micro context (answered in passing).
   */
  qdp: z.enum(["page", "section", "micro"]),
  /** For qdp "section" or "micro": the cluster whose page hosts it. */
  hostClusterId: z.string().optional(),
  /** Flagged for human review: weak or ambiguous overlap. */
  outlier: z.boolean().default(false),
});
export type Cluster = z.infer<typeof Cluster>;

/** Minimum shared top-10 URLs for two queries to share a page (ADR 0003). */
export const MIN_SHARED_URLS = 3;
