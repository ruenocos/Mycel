import { ClientContext, ClusterSet, FilteredQuery, SiteMaps, SitePage } from "@mycel/schema";
import { z } from "zod";
import type { JsonModel } from "../context/llm.ts";
import { languageName } from "../evals/writing.ts";
import type { StepContext } from "../log/run-store.ts";
import { pool } from "../research/collect.ts";
import { defineStep } from "../step.ts";
import {
  finishMaps,
  hubChoices,
  type MapPlan,
  type NodeDraft,
  type NodeLabel,
  planMaps,
} from "./build.ts";

/**
 * Step 11-14 and 20, the model half (issue #19). Data already fixed the pages, tiers, intent and
 * most of the hierarchy. The model only adds what words and numbers can't: the raw node's
 * attribute, one macro context per page, a plain "why", and a hub for top-level pages whose words
 * don't nest under another page. It never adds pages, queries or numbers.
 */

export const MAP_TEMPLATE = { id: "map-label", version: "1" } as const;

/** Step logic version (planner + prompt); bump when either changes. 1: first map. */
export const MAP_STEP_VERSION = "1";

export const LabelAnswer = z.object({
  results: z.array(
    z.object({
      i: z.number().int().nonnegative(),
      attribute: z.string().max(60).optional(),
      macroContext: z.string().max(240).optional(),
      why: z.string().max(300).optional(),
      /** Only for top-level pages: a hub id ("h3") or "root". */
      parent: z.string().max(20).optional(),
    }),
  ),
});
export type LabelAnswer = z.infer<typeof LabelAnswer>;

/** Most hubs offered per prompt: core first, then demand. Enough for every map we have seen. */
const MAX_HUBS = 120;

export function buildLabelMessages(
  ctx: ClientContext,
  entity: string,
  batch: NodeDraft[],
  hubs: NodeDraft[],
  byId: Map<string, NodeDraft>,
) {
  const lang = languageName(ctx.market.language);
  const hubKey = new Map(hubs.map((h, i) => [h.id, `h${i}`]));
  const system = [
    `You help build a topical map for one business: a tree of pages around the central entity "${entity}". The pages, their search queries, tier (core or outer) and search intent are already decided from search data. Do not change them, and do not invent facts, numbers or queries.`,
    "For each numbered page give:",
    `- "attribute": the attribute of the central entity this page covers, in English, 1 to 4 words (e.g. "price", "for construction firms", "installation"). For the page that is just the entity itself, use "overview".`,
    `- "macroContext": in ${lang}, one sentence: the single main angle of the page, so two pages never cover the same thing.`,
    `- "why": in ${lang}, one plain sentence for the business owner: why this deserves its own page, and why it is core (close to what they sell) or outer (supporting knowledge). Use the given data (queries, volume, intent); no jargon.`,
    `- "parent": only for pages marked top-level. Pick the hub this page belongs under, from the hub list (its id, e.g. "h3"), or "root" when it belongs directly under "${entity}". Choose a hub only when the page is clearly a narrower part of that hub's topic. A core page never goes under an outer hub. Never pick the page itself.`,
    'Answer with JSON: {"results":[{"i":0,"attribute":"...","macroContext":"...","why":"...","parent":"h3"}]}. Answer every number exactly once.',
  ].join("\n");
  const profile = {
    business: ctx.site.name,
    market: ctx.market,
    sourceContext: ctx.sourceContext,
    centralEntity: ctx.centralEntities.find((e) => e.name === entity) ?? { name: entity },
    centralSearchIntent: ctx.centralSearchIntent,
    offerings: ctx.offerings,
    audiences: ctx.audiences,
  };
  const pages = batch.map((n, i) => ({
    i,
    page: n.mainQuery,
    tier: n.isRoot ? "root" : n.section,
    intent: n.intent.main,
    volume: n.volume,
    queries: n.queries.slice(0, 8),
    ...(n.sections.length ? { sections: n.sections.slice(0, 5).map((s) => s.mainQuery) } : {}),
    ...(n.isRoot
      ? {}
      : n.parentId
        ? { under: byId.get(n.parentId)?.mainQuery }
        : { topLevel: true }),
  }));
  const hubList = hubs.map((h) => ({
    id: hubKey.get(h.id),
    page: h.mainQuery,
    tier: h.section,
  }));
  return [
    { role: "system" as const, content: system },
    {
      role: "user" as const,
      content: `Profile:\n${JSON.stringify(profile, null, 2)}\n\nHubs:\n${JSON.stringify(hubList)}\n\nPages:\n${JSON.stringify(pages, null, 1)}`,
    },
  ];
}

export const MapInput = z.object({
  context: ClientContext,
  clusters: ClusterSet,
  /** Kept queries from the filter: intent and CPC per query. Optional; without them intent falls back to the tier. */
  queries: z.array(FilteredQuery).default([]),
  /** The client's existing pages, to link nodes and flag cannibalisation. */
  pages: z.array(SitePage.pick({ url: true, kind: true, title: true, h1: true })).default([]),
  model: z.string().min(1),
  batchSize: z.number().int().positive().default(25),
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

export async function labelPlan(
  llm: JsonModel,
  plan: MapPlan,
  opts: { model: string; batchSize: number; concurrency: number },
  ctx: StepContext,
): Promise<Map<string, NodeLabel>> {
  const labels = new Map<string, NodeLabel>();
  const work: {
    entity: string;
    batch: NodeDraft[];
    hubs: NodeDraft[];
    byId: Map<string, NodeDraft>;
  }[] = [];
  for (const { entity, nodes } of plan.entities) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const hubs = hubChoices(plan, entity)
      .hubs.slice()
      .sort((a, b) =>
        a.section === b.section ? b.volume - a.volume : a.section === "core" ? -1 : 1,
      )
      .slice(0, MAX_HUBS);
    for (let i = 0; i < nodes.length; i += opts.batchSize) {
      work.push({ entity, batch: nodes.slice(i, i + opts.batchSize), hubs, byId });
    }
  }
  let invalidHubs = 0;
  const ask = async (w: (typeof work)[number], seed: number) => {
    const answer = await llm.generateJson(
      {
        model: opts.model,
        template: MAP_TEMPLATE,
        messages: buildLabelMessages(plan.context, w.entity, w.batch, w.hubs, w.byId),
        params: { temperature: 0, seed },
      },
      LabelAnswer,
      ctx,
    );
    for (const r of answer.results) {
      const n = w.batch[r.i];
      if (!n || labels.has(n.id)) continue;
      const label: NodeLabel = {};
      if (r.attribute?.trim()) label.attribute = r.attribute.trim();
      if (r.macroContext?.trim()) label.macroContext = r.macroContext.trim();
      if (r.why?.trim()) label.why = r.why.trim();
      if (!n.isRoot && !n.parentId && r.parent) {
        const pick = r.parent.trim();
        const hub = pick === "root" ? undefined : w.hubs[Number(pick.replace(/^h/, ""))];
        if (pick === "root") label.parent = "root";
        else if (hub && hub.id !== n.id) label.parent = hub.id;
        else invalidHubs++;
      }
      labels.set(n.id, label);
    }
  };
  await pool(work, opts.concurrency, (w) => ask(w, 11));
  const missing = work
    .map((w) => ({ ...w, batch: w.batch.filter((n) => !labels.has(n.id)) }))
    .filter((w) => w.batch.length);
  if (missing.length) {
    ctx.log.warn("model skipped pages, asking again", {
      count: missing.reduce((s, w) => s + w.batch.length, 0),
    });
    await pool(missing, opts.concurrency, (w) => ask(w, 12));
  }
  const unlabeled = work.flatMap((w) => w.batch).filter((n) => !labels.has(n.id));
  if (unlabeled.length) {
    // Not passed on silently (step contract): the run stops with the pages named.
    throw new Error(
      `the model left ${unlabeled.length} pages unlabeled after a retry, e.g. ${unlabeled
        .slice(0, 5)
        .map((n) => `"${n.mainQuery}"`)
        .join(", ")}`,
    );
  }
  if (invalidHubs)
    ctx.log.warn("model picked hubs that don't exist; page stays top-level", { invalidHubs });
  return labels;
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
      const labels = await labelPlan(
        llm,
        plan,
        { model: input.model, batchSize: input.batchSize, concurrency: input.concurrency },
        meter.rec,
      );
      return finishMaps({
        plan,
        labels,
        pages: input.pages,
        runId: ctx.runId,
        createdAt: new Date().toISOString(),
        costUsd: meter.total(),
      });
    },
  });
}
