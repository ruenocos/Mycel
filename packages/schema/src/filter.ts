import { z } from "zod";
import { Market } from "./context.ts";
import { Query } from "./query.ts";

/**
 * Output of step 9 (issue #17): every research query with a keep/drop decision, the reason,
 * the central entity it belongs to, and its scores. Dropped queries stay in, so a person can
 * see what was thrown out and why.
 */

/**
 * How close a query is to the central entity (Koray step 9 + core/outer sections, doc 02):
 * - core: what the business sells or does, or a buying/comparison question about it;
 * - outer: a smaller attribute, problem or how-to around the entity, supporting the core;
 * - bridge: a broader category or neighbouring subject; worth a mention, never its own page;
 * - off: outside the source context (dropped).
 * "related" was the v2 name for outer and is still read.
 */
export const RELEVANCE_TIERS = ["core", "outer", "bridge", "off"] as const;
export const RelevanceLabel = z.preprocess(
  (v) => (v === "related" ? "outer" : v),
  z.enum(RELEVANCE_TIERS),
);
export type RelevanceLabel = (typeof RELEVANCE_TIERS)[number];

export const FilteredQuery = Query.extend({
  /** The model's judgement; absent when a rule dropped the query before the model saw it. */
  label: RelevanceLabel.optional(),
  /** Short English reason from the model, for review. */
  why: z.string().optional(),
});
export type FilteredQuery = z.infer<typeof FilteredQuery>;

export const FilteredQueries = z
  .object({
    site: z.object({ url: z.url(), name: z.string().min(1) }),
    market: Market,
    queries: z.array(FilteredQuery).min(1),
    stats: z.object({
      total: z.number().int().nonnegative(),
      kept: z.number().int().nonnegative(),
      /** Dropped count per rule ("language", "not this", "own brand", "off", ...). */
      dropped: z.record(z.string(), z.number().int().nonnegative()),
    }),
  })
  .superRefine((d, ctx) => {
    for (const [i, q] of d.queries.entries()) {
      if (!q.filter) {
        ctx.addIssue({
          code: "custom",
          message: "every query needs a filter decision",
          path: ["queries", i],
        });
      }
      if (q.filter?.kept && !q.scores) {
        ctx.addIssue({ code: "custom", message: "kept queries need scores", path: ["queries", i] });
      }
    }
  });
export type FilteredQueries = z.infer<typeof FilteredQueries>;

/** A labeled query for the filter eval (issue #17): what a careful SEO would decide. */
export const FilterEvalCase = z.object({
  query: z.string().min(1),
  expect: z.enum(["keep", "drop"]),
  /** Why, in a few words, so a wrong answer is easy to judge. */
  why: z.string().min(1),
});
export const FilterEvalSet = z.object({
  client: z.string().min(1),
  cases: z.array(FilterEvalCase).min(10),
});
export type FilterEvalSet = z.infer<typeof FilterEvalSet>;
