import { z } from "zod";
import { CentralEntity } from "./context.ts";

/** Fields follow the "Topical map examples" doc: Koray SOP structure + status, priority and a plain "why". */
export const LinkOut = z.object({
  to: z.string().min(1),
  /**
   * to_core: up to the core (Koray step 20). parent / child: the hub and its pages. sibling: pages
   * under one hub. bridge: a side link between two hubs (contextual bridge). from_home: the
   * homepage links to a quality node (step 13).
   */
  type: z.enum(["to_core", "parent", "child", "sibling", "bridge", "from_home"]),
  anchor: z.string().min(1).optional(),
});
export type LinkOut = z.infer<typeof LinkOut>;

/** Search intent of a page: from the queries' data and the results page, the model only breaks ties. */
export const PageIntent = z.object({
  main: z.enum(["informational", "commercial", "transactional", "navigational", "local"]),
  /** A second intent is nearly as strong: often worth two pages (a cost guide and a service page). */
  mixed: z.boolean(),
  /**
   * What decided it: query data and SERP features; a core page naming one of the client's
   * offerings (a service page); or only the tier when there was no data.
   */
  source: z.enum(["data", "offering", "tier"]),
});
export type PageIntent = z.infer<typeof PageIntent>;

/** A cluster that doesn't get its own page: a section on this page, or micro context. */
export const MapSection = z.object({
  clusterId: z.string().min(1),
  mainQuery: z.string().min(1),
  qdp: z.enum(["section", "micro"]),
  queries: z.array(z.string()).default([]),
  volume: z.number().int().nonnegative().default(0),
  /**
   * Set when this was a page of its own that answers the same search as its host: the top-10
   * URLs both share (ADR 0003 bar), the proof for the merge (issue #42, step 4).
   */
  sharedUrls: z.array(z.string()).optional(),
});
export type MapSection = z.infer<typeof MapSection>;

export const MapNode = z.object({
  id: z.string().min(1),
  section: z.enum(["core", "outer"]),
  level: z.enum(["root", "seed", "node"]),
  parentId: z.string().optional(),
  /**
   * "site": an existing section of the client's site (a service, category or location page).
   * It stays a hub at its URL; search data hangs new pages under it instead of replacing it.
   * "theme": a new hub page that groups pages sharing one theme.
   * "offering": the page for one of the business's offerings (issue #42): locked under the root.
   */
  hub: z.enum(["site", "theme", "offering"]).optional(),
  /**
   * Display name in the market language, for people: a site hub's own page heading
   * ("Projectplanning"), else a short title the model wrote from the main search.
   */
  name: z.string().min(1).optional(),
  /** The business profile offering this page serves (issue #42); absent on support pages without one. */
  offeringId: z.string().min(1).optional(),
  /** Koray raw node: entity + attribute, e.g. ERP + bouwbedrijven. */
  rawNode: z.object({ entity: z.string().min(1), attribute: z.string().min(1) }),
  /** One macro context per page. */
  macroContext: z.string().min(1),
  clusterId: z.string().optional(),
  mainQuery: z.string().min(1),
  queries: z.array(z.string()).default([]),
  /** Clusters answered on this page instead of their own (QDP, step 10). */
  sections: z.array(MapSection).default([]),
  intent: PageIntent,
  proposedUrl: z.string().regex(/^\/[a-z0-9\-/]*$/, "lowercase slug path starting with /"),
  /** Null means a new page. */
  existingPage: z
    .object({ url: z.string().min(1), matchScore: z.number().min(0).max(1) })
    .nullable(),
  /** Two or more existing URLs compete for this node. */
  conflict: z
    .object({
      urls: z.array(z.string()).min(2),
      suggestion: z.enum(["merge", "differentiate"]),
    })
    .optional(),
  demand: z
    .object({
      volume: z.number().int().nonnegative().optional(),
      cpc: z.number().nonnegative().optional(),
      gscImpressions: z.number().int().nonnegative().optional(),
    })
    .default({}),
  /** 1 = do first. The first plan ("now") holds 1-3, later work 4-5, pages that are fine 5. */
  priority: z.number().int().min(1).max(5),
  /**
   * What to do with this page. keep: an existing page that already covers it. improve: an
   * existing page that only partly covers it. resolve: existing pages compete for it (see
   * conflict). create: a new page.
   */
  action: z.enum(["keep", "improve", "resolve", "create"]),
  /** In the first plan, or later. Absent for pages to keep as they are. */
  wave: z.enum(["now", "later"]).optional(),
  flags: z.object({ quality: z.boolean(), trending: z.boolean() }),
  linksOut: z.array(LinkOut).default([]),
  /** Null when no SERP was fetched for this node. */
  aiOverview: z.object({ present: z.boolean(), cited: z.boolean() }).nullable(),
  status: z.enum(["idea", "confirmed", "exists_covered", "exists_weak"]),
  /** One plain-language line: why this is a page, and why core or outer. Mycel's differentiator. */
  why: z.string().min(10),
});
export type MapNode = z.infer<typeof MapNode>;

export const MapHeader = z.object({
  site: z.string().min(1),
  runId: z.string().min(1),
  createdAt: z.iso.datetime(),
  sourceContext: z.string().min(1),
  centralEntity: CentralEntity,
  centralSearchIntent: z.string().min(1),
  costUsd: z.number().nonnegative(),
});
export type MapHeader = z.infer<typeof MapHeader>;

/** A search the model judged not to belong in this business's map, with the reason. */
export const LeftOut = z.object({
  mainQuery: z.string().min(1),
  volume: z.number().int().nonnegative().default(0),
  reason: z.enum(["other_business", "place_not_served", "off_offer"]),
});
export type LeftOut = z.infer<typeof LeftOut>;

/**
 * One topical map. The refinements are the deterministic layer-1 quality checks
 * from the plan: unique ids, valid references, every outer node links to a core node.
 */
export const TopicalMap = z
  .object({
    header: MapHeader,
    nodes: z.array(MapNode).min(1),
    /** Searches left out of the map, shown so the owner can put one back. */
    leftOut: z.array(LeftOut).default([]),
  })
  .superRefine((map, ctx) => {
    const ids = new Set<string>();
    for (const [i, n] of map.nodes.entries()) {
      if (ids.has(n.id))
        ctx.addIssue({ code: "custom", path: ["nodes", i, "id"], message: `duplicate id ${n.id}` });
      ids.add(n.id);
    }
    const byId = new Map(map.nodes.map((n) => [n.id, n]));
    for (const [i, n] of map.nodes.entries()) {
      if (n.parentId && !byId.has(n.parentId))
        ctx.addIssue({
          code: "custom",
          path: ["nodes", i, "parentId"],
          message: `unknown parent ${n.parentId}`,
        });
      for (const [j, l] of n.linksOut.entries()) {
        if (!byId.has(l.to))
          ctx.addIssue({
            code: "custom",
            path: ["nodes", i, "linksOut", j, "to"],
            message: `link to unknown node ${l.to}`,
          });
      }
      if (n.section === "outer" && !n.linksOut.some((l) => byId.get(l.to)?.section === "core"))
        ctx.addIssue({
          code: "custom",
          path: ["nodes", i, "linksOut"],
          message: `outer node ${n.id} must link to a core node`,
        });
    }
    for (const [i, n] of map.nodes.entries()) {
      const seen = new Set<string>([n.id]);
      let p = n.parentId ? byId.get(n.parentId) : undefined;
      while (p) {
        if (seen.has(p.id)) {
          ctx.addIssue({
            code: "custom",
            path: ["nodes", i, "parentId"],
            message: `parent loop at ${n.id}`,
          });
          break;
        }
        seen.add(p.id);
        p = p.parentId ? byId.get(p.parentId) : undefined;
      }
    }
    if (!map.nodes.some((n) => n.level === "root"))
      ctx.addIssue({ code: "custom", path: ["nodes"], message: "map needs a root node" });
  });
export type TopicalMap = z.infer<typeof TopicalMap>;

/** A site can hold several maps, one per central entity. */
export const SiteMaps = z.object({
  site: z.string().min(1),
  maps: z.array(TopicalMap).min(1),
  /** Existing pages that serve no map page (news, team, off-topic articles): outside the map. */
  outside: z
    .array(z.object({ url: z.string().min(1), kind: z.string().min(1), title: z.string() }))
    .default([]),
});
export type SiteMaps = z.infer<typeof SiteMaps>;
