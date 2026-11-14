import {
  ClientContext,
  FilteredQueries,
  type FilteredQuery,
  Query,
  RelevanceLabel,
} from "@mycel/schema";
import { z } from "zod";
import type { JsonModel } from "../context/llm.ts";
import { languageName } from "../evals/writing.ts";
import { pool } from "../research/collect.ts";
import { brandTokens } from "../research/seeds.ts";
import { defineStep } from "../step.ts";
import { mergeDuplicates, ruleFor, scoreQueries } from "./rules.ts";

/**
 * Step 9, the model half (issue #17): the model reads the confirmed context and labels each query
 * core, related or off, and names the central entity it is about. It judges meaning (ERP the
 * software, not Erp the village); it never adds queries or numbers.
 */

export const FILTER_TEMPLATE = { id: "filter-classify", version: "1" } as const;

/** Step logic version (rules + prompt); bump when either changes. 2: no drop on detected language. */
export const FILTER_STEP_VERSION = "2";

export const ClassifyAnswer = z.object({
  results: z.array(
    z.object({
      i: z.number().int().nonnegative(),
      label: RelevanceLabel,
      /** Exact central entity name, or empty when off. */
      entity: z.string().optional(),
      why: z.string().max(200).optional(),
    }),
  ),
});
export type ClassifyAnswer = z.infer<typeof ClassifyAnswer>;

export function buildClassifyMessages(ctx: ClientContext, batch: string[]) {
  const lang = languageName(ctx.market.language);
  const local = ctx.market.city
    ? `This is a local business in ${ctx.market.city}. A query that names another town or city (and not ${ctx.market.city} or a place inside it) is off.`
    : "";
  const system = [
    "You decide which search queries belong in a topical map for one business. You get the business profile and a numbered list of queries (in " +
      lang +
      ").",
    "Label each query:",
    '- "core": about what the business sells or does, or a direct buying or comparison question about it.',
    '- "related": same subject, and a future customer would search it (problems, how-to, costs, care, terms), but not a direct sale.',
    '- "off": a different meaning of the words, a different subject, jobs, education or courses, a different location, or a navigational search for an unrelated company.',
    `A query in another language than ${lang} is off, unless it is a term people in this market search in that form.`,
    "Use the profile's meaning of each central entity. A query that uses the same word in another sense is off. Things listed under notThis are off.",
    "Competitor names are fine when the query compares or chooses between options; a plain search for a competitor's own site or login is off.",
    local,
    'Answer with JSON: {"results":[{"i":0,"label":"core|related|off","entity":"<exact central entity name, empty when off>","why":"<a few English words>"}]}. Answer every number exactly once.',
  ]
    .filter(Boolean)
    .join("\n");
  const profile = {
    business: ctx.site.name,
    market: ctx.market,
    sourceContext: ctx.sourceContext,
    centralEntities: ctx.centralEntities.map((e) => ({
      name: e.name,
      meaning: e.disambiguation,
      notThis: e.notThis,
    })),
    centralSearchIntent: ctx.centralSearchIntent,
    offerings: ctx.offerings,
    audiences: ctx.audiences,
    competitors: ctx.competitors,
  };
  const list = batch.map((q, i) => `${i}. ${q}`).join("\n");
  return [
    { role: "system" as const, content: system },
    {
      role: "user" as const,
      content: `Profile:\n${JSON.stringify(profile, null, 2)}\n\nQueries:\n${list}`,
    },
  ];
}

export const FilterInput = z.object({
  context: ClientContext,
  site: z.object({ url: z.url(), name: z.string().min(1) }),
  queries: z.array(Query).min(1),
  model: z.string().min(1),
  batchSize: z.number().int().positive().default(60),
  concurrency: z.number().int().positive().default(3),
});
export type FilterInput = z.input<typeof FilterInput>;

type Label = { label: z.infer<typeof RelevanceLabel>; entity?: string; why?: string };

export function filterStep(llm: JsonModel) {
  return defineStep({
    name: "filter",
    version: FILTER_STEP_VERSION,
    input: FilterInput,
    output: FilteredQueries,
    async run(input, ctx) {
      const { context } = input;
      const brands = brandTokens(context);
      const entities = new Set(context.centralEntities.map((e) => e.name));
      const { queries, merged } = mergeDuplicates(input.queries);
      const dropped: Record<string, number> = {};
      const drop = (q: FilteredQuery, rule: string, reason: string) => {
        q.filter = { kept: false, reason };
        dropped[rule] = (dropped[rule] ?? 0) + 1;
      };
      if (merged) dropped.duplicate = merged;

      const toModel: FilteredQuery[] = [];
      for (const q of queries) {
        if (q.filter) continue; // a merged duplicate
        const hit = ruleFor(q, context, brands);
        if (hit) drop(q, hit.rule, hit.reason);
        else toModel.push(q);
      }
      ctx.log.info("filter rules", { total: queries.length, toModel: toModel.length, dropped });

      // Model labels, in batches; a batch that misses numbers is asked again for just those.
      const labels = new Map<FilteredQuery, Label>();
      const ask = async (batch: FilteredQuery[], seed: number) => {
        const answer = await llm.generateJson(
          {
            model: input.model,
            template: FILTER_TEMPLATE,
            messages: buildClassifyMessages(
              context,
              batch.map((q) => q.text),
            ),
            params: { temperature: 0, seed },
          },
          ClassifyAnswer,
          ctx,
        );
        for (const r of answer.results) {
          const q = batch[r.i];
          if (!q || labels.has(q)) continue;
          labels.set(q, {
            label: r.label,
            ...(r.entity && entities.has(r.entity) ? { entity: r.entity } : {}),
            ...(r.why ? { why: r.why } : {}),
          });
        }
      };
      const batches: FilteredQuery[][] = [];
      for (let i = 0; i < toModel.length; i += input.batchSize) {
        batches.push(toModel.slice(i, i + input.batchSize));
      }
      await pool(batches, input.concurrency, (b) => ask(b, 9));
      const missing = toModel.filter((q) => !labels.has(q));
      if (missing.length) {
        ctx.log.warn("model skipped queries, asking again", { count: missing.length });
        await pool(
          Array.from({ length: Math.ceil(missing.length / input.batchSize) }, (_, i) =>
            missing.slice(i * input.batchSize, (i + 1) * input.batchSize),
          ),
          input.concurrency,
          (b) => ask(b, 10),
        );
      }
      const unlabeled = toModel.filter((q) => !labels.has(q));
      if (unlabeled.length) {
        // Not passed on silently (step contract): the run stops with the queries named.
        throw new Error(
          `the model left ${unlabeled.length} queries unlabeled after a retry, e.g. ${unlabeled
            .slice(0, 5)
            .map((q) => `"${q.text}"`)
            .join(", ")}`,
        );
      }
      for (const q of toModel) {
        const l = labels.get(q) as Label;
        q.label = l.label;
        if (l.why) q.why = l.why;
        if (l.label === "off") {
          drop(q, "off", `off topic${l.why ? `: ${l.why}` : ""}`);
        } else {
          q.filter = { kept: true };
          if (l.entity) q.entity = l.entity;
          else if (entities.size === 1) q.entity = [...entities][0] as string;
        }
      }
      scoreQueries(queries);
      const kept = queries.filter((q) => q.filter?.kept).length;
      ctx.log.info("filter done", { total: queries.length, kept, dropped });
      return {
        site: input.site,
        market: context.market,
        queries,
        stats: { total: queries.length, kept, dropped },
      };
    },
  });
}
