import { z } from "zod";

/**
 * The map eval (issue #42, step 0): fixed numbers that say whether a topical map got better, so
 * a round is judged on the same ruler every time instead of a reviewer's feeling.
 */

/** One number, with what it was counted over and a few examples a person can check. */
export const MapMetric = z.object({
  /** Null when the input needed for it is missing (see note). */
  value: z.number().nullable(),
  /** What the value is a share or count of, when that helps reading it. */
  of: z.number().int().nonnegative().optional(),
  examples: z.array(z.string()).default([]),
  note: z.string().optional(),
});
export type MapMetric = z.infer<typeof MapMetric>;

export const MAP_METRICS = [
  "duplicateIntentPairs",
  "coreWithoutOffering",
  "notOfferedPages",
  "nowNotTied",
  "outsideWithTwin",
  "existingWithJob",
  "newPages",
  "claimFailures",
  "pagesWithoutSection",
  "newOutsideSectionFolder",
] as const;
export type MapMetricId = (typeof MAP_METRICS)[number];

/** Round 8 targets (doc "Topical map round 8: plan", Done when). */
export const MAP_TARGETS: Record<MapMetricId, { max?: number; min?: number; label: string }> = {
  duplicateIntentPairs: { max: 0, label: "page pairs sharing 3+ top-10 results" },
  coreWithoutOffering: { max: 0, label: "core pages without an offering" },
  notOfferedPages: { max: 0, label: "pages for something the business doesn't offer" },
  nowNotTied: { max: 0, label: "first-plan steps not tied to a top offering or a conflict" },
  outsideWithTwin: { max: 0, label: "existing pages outside the map next to a planned twin" },
  existingWithJob: { min: 0.9, label: "share of existing pages with a job" },
  newPages: { label: "new pages (target: half of round 7.1 or fewer)" },
  claimFailures: { max: 0, label: "failed fact checks in names and why-texts" },
  pagesWithoutSection: { max: 0, label: "pages without a site section (issue #51)" },
  newOutsideSectionFolder: {
    max: 0,
    label: "new pages whose URL is outside their section's folder",
  },
};

export const MapEval = z.object({
  site: z.string().min(1),
  createdAt: z.iso.datetime(),
  /** Whether the client's business profile was there; without it some numbers use offerings only. */
  withProfile: z.boolean(),
  counts: z.object({
    pages: z.number().int().nonnegative(),
    core: z.number().int().nonnegative(),
    outer: z.number().int().nonnegative(),
    actions: z.record(z.string(), z.number().int().nonnegative()),
    now: z.record(z.string(), z.number().int().nonnegative()),
    leftOut: z.number().int().nonnegative(),
    outside: z.number().int().nonnegative(),
  }),
  metrics: z.object(
    Object.fromEntries(MAP_METRICS.map((m) => [m, MapMetric])) as Record<
      MapMetricId,
      typeof MapMetric
    >,
  ),
});
export type MapEval = z.infer<typeof MapEval>;
