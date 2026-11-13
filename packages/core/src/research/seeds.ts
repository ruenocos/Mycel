import { ClientContext, normalizeQuery, ResearchSeed } from "@mycel/schema";
import { z } from "zod";
import type { JsonModel } from "../context/llm.ts";
import { languageName } from "../evals/writing.ts";
import { defineStep } from "../step.ts";

/**
 * Seeds for the research step (Koray step 7). Data first: entity names, short offerings and the
 * client's own non-brand search queries are always seeds. The model only adds phrasings a
 * searcher would type for offerings that are written as sentences; it never supplies metrics.
 */

export const SEEDS_TEMPLATE = { id: "research-seeds", version: "1" } as const;

/** Seeds longer than this are sentences, not searches. */
const MAX_SEED_WORDS = 5;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Brand tokens from the site name and host, spaces removed: "De Saak" + desaak.com → ["desaak"]. */
export function brandTokens(ctx: Pick<ClientContext, "site">): string[] {
  const host = new URL(ctx.site.url).hostname.replace(/^www\./, "");
  const flat = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const label = flat(host.split(".")[0] ?? "");
  return [...new Set([label, flat(ctx.site.name)].filter((t) => t.length >= 3))];
}

export function isBrandQuery(query: string, brands: string[]): boolean {
  const flat = query.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return brands.some((b) => flat.includes(b));
}

export interface SeedData {
  gscQueries?: { query: string; impressions: number }[] | undefined;
  rankedKeywords?: { keyword: string; volume?: number | undefined; position?: number | undefined }[] | undefined;
}

export interface SeedLimits {
  fromGsc?: number;
  fromRanked?: number;
}

/** Seeds that need no model: entities, short offerings, entity + city, top non-brand queries. */
export function deterministicSeeds(
  ctx: ClientContext,
  data: SeedData = {},
  limits: SeedLimits = {},
): ResearchSeed[] {
  const out = new Map<string, ResearchSeed>();
  const add = (text: string, basis: ResearchSeed["basis"], ref?: string) => {
    const normalized = normalizeQuery(text);
    if (!normalized || out.has(normalized)) return;
    out.set(normalized, { text: text.trim(), normalized, basis, ...(ref ? { ref } : {}) });
  };
  const brands = brandTokens(ctx);
  for (const e of ctx.centralEntities) {
    add(e.name, "entity", e.name);
    if (ctx.market.city) add(`${e.name} ${ctx.market.city}`, "entity", e.name);
  }
  for (const o of ctx.offerings) if (words(o) <= MAX_SEED_WORDS - 1) add(o, "offering", o);
  const gsc = (data.gscQueries ?? [])
    .filter((q) => !isBrandQuery(q.query, brands) && words(q.query) <= MAX_SEED_WORDS)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limits.fromGsc ?? 5);
  for (const q of gsc) add(q.query, "gsc");
  const ranked = (data.rankedKeywords ?? [])
    .filter(
      (k) =>
        !isBrandQuery(k.keyword, brands) &&
        words(k.keyword) <= MAX_SEED_WORDS &&
        (k.position ?? 100) <= 20,
    )
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, limits.fromRanked ?? 5);
  for (const k of ranked) add(k.keyword, "ranked");
  return [...out.values()];
}

export const SeedProposal = z.object({
  seeds: z
    .array(
      z.object({
        query: z.string().min(1),
        /** The exact central entity name or offering this seed is about. */
        ref: z.string().min(1),
      }),
    )
    .min(1),
});
export type SeedProposal = z.infer<typeof SeedProposal>;

export function buildSeedMessages(ctx: ClientContext, existing: ResearchSeed[]) {
  const lang = languageName(ctx.market.language);
  const where = [ctx.market.city, ctx.market.country].filter(Boolean).join(", ");
  const system = [
    "You prepare keyword research for a topical map. You get a confirmed client profile.",
    `Propose seed search queries: short queries (1 to ${MAX_SEED_WORDS} words) that a searcher in ${where} would type into Google, written in ${lang} exactly as people search (lowercase, no punctuation).`,
    "Cover every central entity and every offering at least once. Mix buying queries (e.g. price, buy, provider, comparison) with problem and how-to queries a future customer has before buying.",
    "Use only what the profile says the business does. Do not invent products, places or claims.",
    "Never include the client's own brand name. Never include competitor brand names.",
    "Do not repeat the existing seeds. Do not mix in English words unless they are the term people search for in this market.",
    'Answer with JSON: {"seeds":[{"query":"...","ref":"<exact entity name or offering from the profile>"}]}. Give 8 to 20 seeds.',
  ].join("\n");
  const profile = {
    site: ctx.site.name,
    market: ctx.market,
    sourceContext: ctx.sourceContext,
    centralEntities: ctx.centralEntities.map((e) => ({
      name: e.name,
      meaning: e.disambiguation,
      notThis: e.notThis,
    })),
    centralSearchIntent: ctx.centralSearchIntent,
    audiences: ctx.audiences,
    offerings: ctx.offerings,
    existingSeeds: existing.map((s) => s.text),
  };
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: JSON.stringify(profile, null, 2) },
  ];
}

/** Keeps model seeds that are short, new, not brand, and tied to a real entity or offering. */
export function checkSeeds(
  ctx: ClientContext,
  existing: ResearchSeed[],
  proposal: SeedProposal,
): { seeds: ResearchSeed[]; dropped: { query: string; reason: string }[] } {
  const brands = [...brandTokens(ctx)];
  const competitorBrands = ctx.competitors
    .map((d) => d.replace(/^www\./, "").split(".")[0]?.toLowerCase() ?? "")
    .filter((t) => t.length >= 3);
  const entities = new Set(ctx.centralEntities.map((e) => e.name));
  const offerings = new Set(ctx.offerings);
  const seen = new Set(existing.map((s) => s.normalized));
  const seeds: ResearchSeed[] = [];
  const dropped: { query: string; reason: string }[] = [];
  for (const s of proposal.seeds) {
    const normalized = normalizeQuery(s.query);
    const reason = !normalized
      ? "empty"
      : words(normalized) > MAX_SEED_WORDS
        ? "too long"
        : seen.has(normalized)
          ? "duplicate"
          : isBrandQuery(normalized, brands)
            ? "own brand"
            : isBrandQuery(normalized, competitorBrands)
              ? "competitor brand"
              : !entities.has(s.ref) && !offerings.has(s.ref)
                ? "ref is not an entity or offering"
                : null;
    if (reason) {
      dropped.push({ query: s.query, reason });
      continue;
    }
    seen.add(normalized);
    seeds.push({
      text: normalized,
      normalized,
      basis: "model",
      ref: s.ref,
    });
  }
  return { seeds, dropped };
}

export const SeedsInput = z.object({
  context: ClientContext,
  data: z
    .object({
      gscQueries: z.array(z.object({ query: z.string(), impressions: z.number() })).optional(),
      rankedKeywords: z
        .array(
          z.object({
            keyword: z.string(),
            volume: z.number().optional(),
            position: z.number().optional(),
          }),
        )
        .optional(),
    })
    .default({}),
  model: z.string().min(1),
  /** Skip the model: deterministic seeds only. */
  noModel: z.boolean().default(false),
});

export const SeedsOutput = z.array(ResearchSeed).min(1);

export function researchSeedsStep(llm: JsonModel) {
  return defineStep({
    name: "research-seeds",
    version: SEEDS_TEMPLATE.version,
    input: SeedsInput,
    output: SeedsOutput,
    maxAttempts: 2,
    async run(input, ctx) {
      const base = deterministicSeeds(input.context, input.data);
      if (input.noModel) return base;
      const proposal = await llm.generateJson(
        {
          model: input.model,
          template: SEEDS_TEMPLATE,
          messages: buildSeedMessages(input.context, base),
          params: { temperature: 0.3, seed: 16 + ctx.attempt },
        },
        SeedProposal,
        ctx,
      );
      const { seeds, dropped } = checkSeeds(input.context, base, proposal);
      if (dropped.length) ctx.log.warn("model seeds dropped", { dropped });
      ctx.log.info("seeds", { deterministic: base.length, model: seeds.length });
      return [...base, ...seeds];
    },
  });
}
