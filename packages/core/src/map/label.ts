import type { ClientContext } from "@mycel/schema";
import { z } from "zod";
import type { JsonModel } from "../context/llm.ts";
import { languageName } from "../evals/writing.ts";
import type { StepContext } from "../log/run-store.ts";
import { pool } from "../research/collect.ts";
import {
  type FitReason,
  hubChoices,
  type MapPlan,
  type NodeDraft,
  type NodeLabel,
} from "./plan.ts";
import { MAX_HUBS } from "./rules.ts";
import { type PageRef, pageTitle } from "./site.ts";

/**
 * Steps 11-14, the model's labels (issue #19). Data already fixed the pages, tiers, intent and
 * most of the hierarchy. The model only adds what words and numbers can't: the raw node's
 * attribute, one macro context per page, a plain "why", a display name, whether the page belongs
 * in this business's map at all, and a hub for top-level pages whose words don't nest under
 * another page. It never adds pages, queries or numbers.
 */

export const MAP_TEMPLATE = { id: "map-label", version: "8" } as const;

export const LabelAnswer = z.object({
  results: z.array(
    z.object({
      i: z.number().int().nonnegative(),
      attribute: z.string().max(60).nullish(),
      macroContext: z.string().max(240).nullish(),
      why: z.string().max(300).nullish(),
      /** A short page title in the market language. */
      name: z.string().max(80).nullish(),
      /** Only when the page doesn't belong in this business's map. */
      drop: z.enum(["other_business", "place_not_served", "off_offer"]).nullish(),
      /** Only for top-level pages: a hub id ("h3") or "root". */
      parent: z.string().max(20).nullish(),
      /** Only for pages marked pickOffering: an offering id ("o2") or null. */
      offering: z.string().max(20).nullish(),
    }),
  ),
});
export type LabelAnswer = z.infer<typeof LabelAnswer>;

export function buildLabelMessages(
  ctx: ClientContext,
  entity: string,
  batch: NodeDraft[],
  hubs: NodeDraft[],
  byId: Map<string, NodeDraft>,
  locations: string[] = [],
) {
  const lang = languageName(ctx.market.language);
  const hubKey = new Map(hubs.map((h, i) => [h.id, `h${i}`]));
  const system = [
    `You help build a topical map for one business: a tree of pages around the central entity "${entity}". The pages, their search queries, tier (core or outer) and search intent are already decided from search data. Do not change them, and do not invent facts, numbers or queries.`,
    "For each numbered page give:",
    `- "attribute": the attribute of the central entity this page covers, in English, 1 to 4 words (e.g. "price", "for construction firms", "installation"). For the page that is just the entity itself, use "overview".`,
    `- "macroContext": in ${lang}, one sentence that describes the single main angle of the page, so two pages never cover the same thing. Describe it neutrally; don't address anyone.`,
    `- "why": in ${lang}, one plain sentence for the business owner: why this deserves its own page, and why it is core (close to what they sell) or outer (supporting knowledge). Use the given data (queries, volume, intent); no jargon. Address the owner with the informal singular "you" every time; never the plural "you", and never speak as the business ("we", "our"). State only facts from the profile and the page data: never say the business has a location, price, service or experience the profile doesn't list.`,
    `- "name": in ${lang}, a short title for the page (2 to 6 words) as a visitor would read it in a menu or heading: natural word order and correct spelling, not the raw search ("Citroenplant", not "citroen plant kopen online"). Keep a term of art as people write it ("Business Central").`,
    `- "drop": leave it out unless the page clearly doesn't belong in this business's map. Then give one reason: "other_business" (the search is for another named business, brand, website or person), "place_not_served" (it names a town, neighbourhood or street where the business has no location: the profile lists its market and its locations; a neighbourhood or street of the market city without a location counts too, however many people search for it), "off_offer" (it has nothing to do with what the business offers or what its customers ask: a general term from another field, a do-it-yourself or retail product search for a service business). When unsure, leave it out.`,
    `- "parent": required for every page marked topLevel, never null. Pick the hub this page belongs under, from the hub list (its id, e.g. "h3"). Hubs marked "site" are sections the business's website already has (a service, product category or location): prefer them whenever the page is part of that topic, so new pages slot into the existing site. Choose "root" (directly under "${entity}") only when the page is itself a main pillar of the business, a main service, product category or theme that other pages will hang under; a page about one question, one detail or one variant is never root. A core page never goes under an outer hub. Never pick the page itself.`,
    ...(ctx.business
      ? [
          `- "offering": only for pages marked pickOffering. The business offering this page helps sell, from the offering list (its id, e.g. "o2"): the page answers a question its buyers ask, compares it, or explains a part of it. null when it helps sell none of them; such a page needs a strong reason to stay, so judge "drop" with that in mind.`,
        ]
      : []),
    'Answer with JSON: {"results":[{"i":0,"attribute":"...","macroContext":"...","why":"...","name":"...","parent":"h3"}]}. Answer every number exactly once.',
  ].join("\n");
  const offerKey = new Map((ctx.business?.offerings ?? []).map((o, i) => [o.id, `o${i}`]));
  const profile = {
    business: ctx.site.name,
    market: ctx.market,
    sourceContext: ctx.sourceContext,
    centralEntity: ctx.centralEntities.find((e) => e.name === entity) ?? { name: entity },
    centralSearchIntent: ctx.centralSearchIntent,
    offerings: ctx.business
      ? ctx.business.offerings.map((o) => ({
          id: offerKey.get(o.id),
          name: o.name,
          ...(o.subOfferings.length ? { parts: o.subOfferings.slice(0, 8) } : {}),
          ...(o.value === "top" ? { top: true } : {}),
        }))
      : ctx.offerings,
    ...(ctx.business?.notOffered.length
      ? { notOffered: ctx.business.notOffered.map((n) => n.name) }
      : {}),
    audiences: ctx.audiences,
    ...(locations.length ? { locations } : {}),
    ...(ctx.business?.places.nationwide ? { servesWholeCountry: true } : {}),
  };
  const offeringName = new Map((ctx.business?.offerings ?? []).map((o) => [o.id, o.name]));
  const pages = batch.map((n, i) => ({
    i,
    page: n.mainQuery,
    tier: n.isRoot ? "root" : n.section,
    intent: n.intent.main,
    volume: n.volume,
    queries: n.queries.slice(0, 8),
    ...(n.sections.length ? { sections: n.sections.slice(0, 5).map((s) => s.mainQuery) } : {}),
    ...(n.offeringId
      ? { offering: offeringName.get(n.offeringId) }
      : ctx.business && !n.isRoot
        ? { pickOffering: true }
        : {}),
    ...(n.isRoot
      ? {}
      : n.parentId
        ? { under: byId.get(n.parentId)?.mainQuery }
        : n.hub
          ? { siteHub: true }
          : { topLevel: true }),
  }));
  const hubList = hubs.map((h) => ({
    id: hubKey.get(h.id),
    page: h.mainQuery,
    tier: h.section,
    ...(h.hub ? { site: true } : {}),
  }));
  return [
    { role: "system" as const, content: system },
    {
      role: "user" as const,
      content: `Profile:\n${JSON.stringify(profile, null, 2)}\n\nHubs:\n${JSON.stringify(hubList)}\n\nPages:\n${JSON.stringify(pages, null, 1)}`,
    },
  ];
}

export async function labelPlan(
  llm: JsonModel,
  plan: MapPlan,
  opts: { model: string; batchSize: number; concurrency: number },
  ctx: StepContext,
  pages: PageRef[] = [],
  /** Pages already left out by data rules (the offer gate): not worth a model call. */
  skip: Set<string> = new Set(),
): Promise<Map<string, NodeLabel>> {
  const labels = new Map<string, NodeLabel>();
  // Where the business is: its location pages, by name. A place that isn't here isn't served.
  const places = plan.context.business?.places;
  const locations = [
    ...new Set([
      ...pages
        .filter((p) => p.kind === "location")
        .map((p) => pageTitle(p, plan.context.site.name))
        .filter(Boolean),
      ...(places?.locations.map((l) => `${l.name} (${l.city})`) ?? []),
      ...(places && !places.nationwide ? places.serves : []),
    ]),
  ];
  const work: {
    entity: string;
    batch: NodeDraft[];
    hubs: NodeDraft[];
    byId: Map<string, NodeDraft>;
  }[] = [];
  for (const { entity, nodes } of plan.entities) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const hubs = hubChoices(plan, entity)
      .hubs.filter((h) => !skip.has(h.id))
      .sort(
        (a, b) =>
          Number(!!b.hub) - Number(!!a.hub) ||
          (a.section === b.section ? b.volume - a.volume : a.section === "core" ? -1 : 1),
      )
      .slice(0, MAX_HUBS);
    const todo = nodes.filter((n) => !skip.has(n.id));
    for (let i = 0; i < todo.length; i += opts.batchSize) {
      work.push({ entity, batch: todo.slice(i, i + opts.batchSize), hubs, byId });
    }
  }
  let invalidHubs = 0;
  let defaultedHubs = 0;
  /** final: the retry. A top-level page without a valid hub then stays under the root. */
  const ask = async (w: (typeof work)[number], seed: number, final = false) => {
    const answer = await llm.generateJson(
      {
        model: opts.model,
        template: MAP_TEMPLATE,
        messages: buildLabelMessages(plan.context, w.entity, w.batch, w.hubs, w.byId, locations),
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
      if (r.name?.trim()) label.name = r.name.trim();
      if (r.drop) label.drop = r.drop as FitReason;
      const offer = r.offering?.trim();
      if (offer && !n.offeringId && /^o\d+$/.test(offer)) {
        const o = plan.context.business?.offerings[Number(offer.slice(1))];
        if (o) label.offering = o.id;
      }
      if (!n.isRoot && !n.parentId && !n.hub) {
        const pick = r.parent?.trim() ?? "";
        const hub = /^h\d+$/.test(pick) ? w.hubs[Number(pick.slice(1))] : undefined;
        if (pick === "root") label.parent = "root";
        else if (hub && hub.id !== n.id) label.parent = hub.id;
        else if (!final) {
          // No usable hub: ask again rather than silently leave it under the root.
          if (pick) invalidHubs++;
          continue;
        } else defaultedHubs++;
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
    await pool(missing, opts.concurrency, (w) => ask(w, 12, true));
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
  if (invalidHubs) ctx.log.warn("model picked hubs that don't exist; asked again", { invalidHubs });
  if (defaultedHubs)
    ctx.log.warn("no hub after a retry; page stays under the root", { defaultedHubs });
  return labels;
}
