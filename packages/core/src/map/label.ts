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
  type PageRef,
  pageCandidates,
  planMaps,
  scorePages,
} from "./build.ts";

/**
 * Step 11-14 and 20, the model half (issue #19). Data already fixed the pages, tiers, intent and
 * most of the hierarchy. The model only adds what words and numbers can't: the raw node's
 * attribute, one macro context per page, a plain "why", and a hub for top-level pages whose words
 * don't nest under another page, and which existing pages serve each page's search (it reads
 * meaning, so "XL planten" can be the big-plants page). It never adds pages, queries or numbers.
 */

export const MAP_TEMPLATE = { id: "map-label", version: "2" } as const;

/**
 * Step logic version (planner + prompt); bump when either changes. 1: first map.
 * 2: brand searches fold into the root; navigational needs a brand; offerings are service pages;
 *    the model links existing pages from weighted word candidates; one voice for "why".
 */
export const MAP_STEP_VERSION = "2";

export const LabelAnswer = z.object({
  results: z.array(
    z.object({
      i: z.number().int().nonnegative(),
      attribute: z.string().max(60).nullish(),
      macroContext: z.string().max(240).nullish(),
      why: z.string().max(300).nullish(),
      /** Only for top-level pages: a hub id ("h3") or "root". */
      parent: z.string().max(20).nullish(),
      /** Ids of existing pages ("p3") that serve this page's search. */
      pages: z.array(z.string().max(12)).nullish(),
    }),
  ),
});
export type LabelAnswer = z.infer<typeof LabelAnswer>;

/** Most hubs offered per prompt: core first, then demand. Enough for every map we have seen. */
const MAX_HUBS = 120;

/** Most existing pages listed per prompt: word candidates first. */
const MAX_PAGES = 250;

/** The client's existing pages as the model sees them, with ids, and each node's candidates. */
export interface PageList {
  pages: { id: string; url: string; title: string; h1: string }[];
  candidates: Map<string, string[]>;
}

export function buildLabelMessages(
  ctx: ClientContext,
  entity: string,
  batch: NodeDraft[],
  hubs: NodeDraft[],
  byId: Map<string, NodeDraft>,
  site: PageList = { pages: [], candidates: new Map() },
) {
  const lang = languageName(ctx.market.language);
  const withPages = site.pages.length > 0;
  const hubKey = new Map(hubs.map((h, i) => [h.id, `h${i}`]));
  const system = [
    `You help build a topical map for one business: a tree of pages around the central entity "${entity}". The pages, their search queries, tier (core or outer) and search intent are already decided from search data. Do not change them, and do not invent facts, numbers or queries.`,
    "For each numbered page give:",
    `- "attribute": the attribute of the central entity this page covers, in English, 1 to 4 words (e.g. "price", "for construction firms", "installation"). For the page that is just the entity itself, use "overview".`,
    `- "macroContext": in ${lang}, one sentence that describes the single main angle of the page, so two pages never cover the same thing. Describe it neutrally; don't address anyone.`,
    `- "why": in ${lang}, one plain sentence for the business owner: why this deserves its own page, and why it is core (close to what they sell) or outer (supporting knowledge). Use the given data (queries, volume, intent); no jargon. Address the owner with the informal singular "you" every time; never the plural "you", and never speak as the business ("we", "our").`,
    `- "parent": only for pages marked top-level. Pick the hub this page belongs under, from the hub list (its id, e.g. "h3"), or "root" when it belongs directly under "${entity}". Choose a hub only when the page is clearly a narrower part of that hub's topic. A core page never goes under an outer hub. Never pick the page itself.`,
    withPages
      ? `- "pages": ids from the existing pages list (e.g. ["p3"]) whose main topic is this page's search: someone searching it would land well on that page. Judge meaning, not shared words: a page about one product or one town is not the page for the general search. Pages listed as "likely" share the most words; confirm them only when the topic truly matches. Usually none or one; list two or more only when several existing pages target this same search. [] when none.`
      : "",
    `Answer with JSON: {"results":[{"i":0,"attribute":"...","macroContext":"...","why":"...","parent":"h3"${withPages ? ',"pages":[]' : ""}}]}. Answer every number exactly once.`,
  ]
    .filter(Boolean)
    .join("\n");
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
    ...(withPages && site.candidates.get(n.id)?.length
      ? { likely: site.candidates.get(n.id) }
      : {}),
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
      content: `Profile:\n${JSON.stringify(profile, null, 2)}\n\nHubs:\n${JSON.stringify(hubList)}${
        withPages
          ? `\n\nExisting pages:\n${site.pages.map((p) => JSON.stringify(p)).join("\n")}`
          : ""
      }\n\nPages:\n${JSON.stringify(pages, null, 1)}`,
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
  opts: { model: string; batchSize: number; concurrency: number; pages?: PageRef[] },
  ctx: StepContext,
): Promise<Map<string, NodeLabel>> {
  const labels = new Map<string, NodeLabel>();
  const work: {
    entity: string;
    batch: NodeDraft[];
    hubs: NodeDraft[];
    byId: Map<string, NodeDraft>;
    site: PageList;
    urlOf: Map<string, string>;
  }[] = [];
  const existing = (opts.pages ?? []).filter(
    (p) => p.url !== "/" && !["home", "about", "contact"].includes(p.kind),
  );
  let invalidPages = 0;
  for (const { entity, nodes } of plan.entities) {
    const scores = scorePages(nodes, existing, plan.context);
    const cand = new Map(nodes.map((n) => [n.id, pageCandidates(scores, n.id)]));
    const wanted = new Set([...cand.values()].flat());
    const listed = [
      ...existing.filter((p) => wanted.has(p.url)),
      ...existing.filter((p) => !wanted.has(p.url)),
    ].slice(0, MAX_PAGES);
    const idOf = new Map(listed.map((p, i) => [p.url, `p${i}`]));
    const site: PageList = {
      pages: listed.map((p) => ({
        id: idOf.get(p.url) as string,
        url: p.url,
        title: p.title,
        h1: p.h1,
      })),
      candidates: new Map(
        [...cand].map(([id, urls]) => [
          id,
          urls.map((u) => idOf.get(u)).filter((x): x is string => !!x),
        ]),
      ),
    };
    const urlOf = new Map(listed.map((p) => [idOf.get(p.url) as string, p.url]));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const hubs = hubChoices(plan, entity)
      .hubs.slice()
      .sort((a, b) =>
        a.section === b.section ? b.volume - a.volume : a.section === "core" ? -1 : 1,
      )
      .slice(0, MAX_HUBS);
    for (let i = 0; i < nodes.length; i += opts.batchSize) {
      work.push({ entity, batch: nodes.slice(i, i + opts.batchSize), hubs, byId, site, urlOf });
    }
  }
  let invalidHubs = 0;
  const ask = async (w: (typeof work)[number], seed: number) => {
    const answer = await llm.generateJson(
      {
        model: opts.model,
        template: MAP_TEMPLATE,
        messages: buildLabelMessages(plan.context, w.entity, w.batch, w.hubs, w.byId, w.site),
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
      if (w.site.pages.length && !n.isRoot) {
        const urls = (r.pages ?? []).map((id) => w.urlOf.get(id.trim()));
        invalidPages += urls.filter((u) => !u).length;
        label.pages = [...new Set(urls.filter((u): u is string => !!u))];
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
  if (invalidPages) ctx.log.warn("model named existing pages that don't exist", { invalidPages });
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
        {
          model: input.model,
          batchSize: input.batchSize,
          concurrency: input.concurrency,
          pages: input.pages,
        },
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
