import { z } from "zod";

export const QuerySource = z.enum([
  "gsc",
  "dfs_related",
  "dfs_suggestions",
  "dfs_ranked_site",
  "dfs_ranked_competitor",
  "serp_paa",
  "serp_related",
  "page",
]);
export type QuerySource = z.infer<typeof QuerySource>;

const score = z.number().min(0).max(1);

/** A search query as it moves through research (7-8) and filter/score (9). */
export const Query = z.object({
  text: z.string().min(1),
  /** Lowercased, trimmed, whitespace-collapsed; the dedupe key. */
  normalized: z.string().min(1),
  sources: z.array(QuerySource).min(1),
  metrics: z
    .object({
      volume: z.number().int().nonnegative().optional(),
      cpc: z.number().nonnegative().optional(),
      competition: score.optional(),
      gscImpressions: z.number().int().nonnegative().optional(),
      gscClicks: z.number().int().nonnegative().optional(),
      gscPosition: z.number().positive().optional(),
    })
    .default({}),
  intent: z
    .enum(["informational", "commercial", "transactional", "navigational", "local"])
    .optional(),
  /** Which central entity this query belongs to (by name). */
  entity: z.string().optional(),
  scores: z.object({ relevance: score, prominence: score, popularity: score }).optional(),
  /** Set by the noise filter. Dropped queries stay in the data with their reason. */
  filter: z
    .object({
      kept: z.boolean(),
      reason: z.string().optional(),
    })
    .optional(),
});
export type Query = z.infer<typeof Query>;

export function normalizeQuery(text: string): string {
  return text.toLowerCase().normalize("NFC").replace(/\s+/g, " ").trim();
}
