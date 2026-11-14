import { z } from "zod";
import { Market } from "./context.ts";
import { RelevanceLabel } from "./filter.ts";

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

/** One query in a cluster: how many top-10 URLs it shares with the cluster's hub. */
export const ClusterMember = z.object({
  query: z.string().min(1),
  /** Shared top-10 URLs with the hub query (the hub itself: all of its URLs). */
  shared: z.number().int().nonnegative(),
  volume: z.number().int().nonnegative().optional(),
  gscImpressions: z.number().int().nonnegative().optional(),
  /** How it joined when not by sharing results with the hub: a spelling variant or a chained merge. */
  joined: z.string().optional(),
  scores: z.object({
    relevance: z.number().min(0).max(1),
    prominence: z.number().min(0).max(1),
    popularity: z.number().min(0).max(1),
  }),
});
export type ClusterMember = z.infer<typeof ClusterMember>;

/** A cluster with the evidence a person needs to judge it (issue #18). */
export const ClusterDetail = Cluster.extend({
  /** The highest-priority query; every member was compared against its SERP. */
  hub: z.string().min(1),
  /** The closest tier among its members (never "off"). */
  label: RelevanceLabel.refine((l) => l !== "off", "a cluster can't be off topic"),
  entity: z.string().optional(),
  members: z.array(ClusterMember).min(1),
  demand: z.object({
    volume: z.number().int().nonnegative(),
    gscImpressions: z.number().int().nonnegative(),
  }),
  /** AI Overview on the hub SERP, and whether the client is cited in it. */
  aiOverview: z.object({ present: z.boolean(), cited: z.boolean() }),
  serpFeatures: z.array(z.string()),
  /** Why the QDP rule chose page, section or micro. */
  qdpWhy: z.string().min(1),
  outlierReasons: z.array(z.string()).default([]),
});
export type ClusterDetail = z.infer<typeof ClusterDetail>;

export const ClusterSet = z
  .object({
    site: z.object({ url: z.url(), name: z.string().min(1) }),
    market: Market,
    minSharedUrls: z.number().int().positive(),
    clusters: z.array(ClusterDetail),
    /** Kept queries that are not in a cluster: no usable SERP, or no place in the map. */
    unclustered: z.array(z.object({ query: z.string().min(1), reason: z.string().min(1) })),
    stats: z.object({
      queries: z.number().int().nonnegative(),
      clustered: z.number().int().nonnegative(),
      clusters: z.number().int().nonnegative(),
      pages: z.number().int().nonnegative(),
      sections: z.number().int().nonnegative(),
      micro: z.number().int().nonnegative(),
      singletons: z.number().int().nonnegative(),
      outliers: z.number().int().nonnegative(),
      ambiguousMembers: z.number().int().nonnegative(),
      borderlineMembers: z.number().int().nonnegative(),
      /** Sections that are bridge topics (broader than the central entity). */
      bridges: z.number().int().nonnegative().default(0),
      /** Clusters folded into another one (spelling variants, same intent). */
      merged: z.number().int().nonnegative().default(0),
      /** Kept queries with no place in the map (in `unclustered`), e.g. bridges with no host. */
      leftOut: z.number().int().nonnegative().default(0),
    }),
  })
  .superRefine((set, ctx) => {
    const ids = new Map(set.clusters.map((c) => [c.id, c]));
    if (ids.size !== set.clusters.length) {
      ctx.addIssue({ code: "custom", message: "duplicate cluster ids", path: ["clusters"] });
    }
    const seen = new Set<string>();
    const once = (q: string, path: (string | number)[]) => {
      if (seen.has(q)) ctx.addIssue({ code: "custom", message: `query in two places: ${q}`, path });
      seen.add(q);
    };
    for (const [i, c] of set.clusters.entries()) {
      for (const [j, m] of c.members.entries()) once(m.query, ["clusters", i, "members", j]);
      if (c.qdp === "page" && c.hostClusterId) {
        ctx.addIssue({ code: "custom", message: "a page has no host", path: ["clusters", i] });
      }
      if (c.hostClusterId) {
        const host = ids.get(c.hostClusterId);
        if (!host || host.qdp !== "page") {
          ctx.addIssue({
            code: "custom",
            message: `host ${c.hostClusterId} must be a page cluster`,
            path: ["clusters", i, "hostClusterId"],
          });
        }
      }
    }
    for (const [i, u] of set.unclustered.entries()) once(u.query, ["unclustered", i]);
  });
export type ClusterSet = z.infer<typeof ClusterSet>;
