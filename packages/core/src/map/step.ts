import { ClientContext, ClusterSet, FilteredQuery, SiteMaps, SitePage } from "@mycel/schema";
import { z } from "zod";
import type { JsonModel } from "../context/llm.ts";
import type { StepContext } from "../log/run-store.ts";
import { defineStep } from "../step.ts";
import { judgeConflicts } from "./conflict.ts";
import { finishMaps } from "./finish.ts";
import { groupPages } from "./group.ts";
import { labelPlan } from "./label.ts";
import { linkPages } from "./link.ts";
import { planMaps } from "./plan.ts";
import { anchorSiteHubs } from "./site.ts";

/**
 * The map step (Koray steps 11-16 and 20, issue #19). Data first, the model second:
 *
 * 1. plan.ts: clusters become pages with intent, demand and a word-rule parent.
 * 2. link.ts: each existing page picks the map page it serves (and reads untyped pages' kinds).
 * 3. site.ts: the site's own sections become locked hubs, with or without search demand.
 * 4. label.ts: names, angles, a plain "why", hubs for loose pages, and pages that don't belong.
 * 5. group.ts: crowded hubs and loose top-level pages are grouped by theme.
 * 6. finish.ts: tiny pages fold into sections, actions and the first plan, URLs, link plan.
 * 7. conflict.ts: the model judges each conflict: merge or differentiate.
 */

/**
 * Step logic version (planner + prompts); bump when either changes. 1: first map.
 * 2: brand searches fold into the root; navigational needs a brand; offerings are service pages;
 *    the model links existing pages from weighted word candidates; one voice for "why".
 * 3: word matches always count, the model adds pages by meaning; a top-level page needs a hub
 *    answer (asked again); pages with the same words fold together; batches of 15.
 * 4: existing pages are linked page by page (each picks the map page it serves, link.ts);
 *    outer URLs sit under their seed's slug.
 * 5: the site's own service, category and location pages are locked hubs; top-level pages pick
 *    a hub by meaning (site hubs first, "root" only for a main pillar); small childless outer
 *    pages become sections of their hub; a page competing for a second node ("also") is a
 *    differentiate conflict.
 * 6: the model reads untyped pages' kinds while linking (map-link v3); site hubs carry their
 *    page's name; folding keeps buying-intent and costly-click pages; loose top-level pages and
 *    hubs over 40 children are grouped by theme (map-group v1).
 * 7: usable output (map-label v6, map-conflict v1): one page per search however it's spelled,
 *    equal variant volumes count once; pages for other businesses, places not served or outside
 *    the offer are left out (listed); every page gets a display name and an action, and a first
 *    plan of about 30; tiny pages fold more; section pages stay hubs without demand; URLs follow
 *    the site's folders and are cut at a word; the model judges merge vs differentiate; existing
 *    pages outside the map are listed; hubs over 25 children are grouped.
 * 8: places without a location are left out whatever their volume (map-label v7); a question
 *    page is never a hub; new pages with the same title fold together; a site hub shows its
 *    section page, not an article on it; theme names start with a capital; the gate's
 *    childless check leaves the site's own sections out.
 */
export const MAP_STEP_VERSION = "8";

export const MapInput = z.object({
  context: ClientContext,
  clusters: ClusterSet,
  /** Kept queries from the filter: intent and CPC per query. Optional; without them intent falls back to the tier. */
  queries: z.array(FilteredQuery).default([]),
  /** The client's existing pages, to link nodes and flag cannibalisation. */
  pages: z.array(SitePage.pick({ url: true, kind: true, title: true, h1: true })).default([]),
  model: z.string().min(1),
  /** 15 keeps one call well under the provider timeout when several maps run at once. */
  batchSize: z.number().int().positive().default(15),
  concurrency: z.number().int().positive().default(3),
});
export type MapInput = z.input<typeof MapInput>;

/** Wraps the step context so the step can report its own model cost in the map header. */
function costMeter(ctx: StepContext) {
  let usd = 0;
  const rec: StepContext = {
    ...ctx,
    recordLlmCall(r) {
      usd += r.costUsd ?? 0;
      return ctx.recordLlmCall(r);
    },
    recordApiCall: (r) => ctx.recordApiCall(r),
  };
  return { rec, total: () => Math.round(usd * 10000) / 10000 };
}

export function mapStep(llm: JsonModel) {
  return defineStep({
    name: "map",
    version: MAP_STEP_VERSION,
    input: MapInput,
    output: SiteMaps,
    async run(input, ctx) {
      const plan = planMaps({
        context: input.context,
        clusters: input.clusters,
        queries: input.queries,
      });
      ctx.log.info("map plan", {
        entities: plan.entities.map((e) => ({
          entity: e.entity,
          pages: e.nodes.length,
          topLevel: e.nodes.filter((n) => !n.isRoot && !n.parentId).length,
        })),
      });
      const meter = costMeter(ctx);
      const opts = { model: input.model, concurrency: input.concurrency };
      // Existing pages first: the site's own sections become hubs the labels can build on.
      const linked = await linkPages(llm, plan, input.pages, opts, meter.rec);
      // The model's read of untyped pages (WordPress custom types arrive as "other").
      const pages = input.pages.map((p) => {
        const kind = linked.kinds.get(p.url);
        return kind ? { ...p, kind } : p;
      });
      const site = anchorSiteHubs(plan, pages, linked.links);
      ctx.log.info("site hubs", {
        hubs: [...site.hubs].map(([entity, ids]) => ({ entity, count: ids.length })),
      });
      const labels = await labelPlan(
        llm,
        plan,
        { ...opts, batchSize: input.batchSize },
        meter.rec,
        pages,
      );
      const dropped = [...labels.values()].filter((l) => l.drop).length;
      if (dropped) ctx.log.info("pages judged outside the business", { count: dropped });
      const groups = await groupPages(llm, plan, labels, opts, meter.rec);
      const maps = finishMaps({
        plan,
        labels,
        groups,
        pages,
        pageLinks: site.links,
        pageAlso: linked.also,
        runId: ctx.runId,
        createdAt: new Date().toISOString(),
        costUsd: 0,
      });
      await judgeConflicts(llm, maps, input.context, pages, { model: input.model }, meter.rec);
      for (const m of maps.maps) m.header.costUsd = meter.total();
      return maps;
    },
  });
}
