import {
  BusinessProfile,
  type ClientContext,
  OFFERING_FIELDS,
  type Offering,
  type OfferingField,
  type OwnerAnswers,
  OwnerAnswers as OwnerAnswersSchema,
  type Query,
  type SitePage,
  type Source,
} from "@mycel/schema";
import { z } from "zod";
import { variantKey } from "../cluster/cluster.ts";
import { languageName } from "../evals/writing.ts";
import { tokens } from "../map/plan.ts";
import { slugify } from "../map/urls.ts";
import { defineStep } from "../step.ts";
import type { JsonModel } from "./llm.ts";

/**
 * The business profile (issue #42, step 1). AI fills every field it can prove from the site and
 * the search data already collected; whatever it can't prove is marked unknown and asked in the
 * setup, never guessed. The owner's answers are merged on top (applyOwnerAnswers). No paid calls:
 * search evidence comes from the research dataset that is already on disk.
 */

export const BUSINESS_TEMPLATE = { id: "business-propose", version: "3" } as const;

/** Kinds whose body text says what the business offers, in reading order. */
const OFFER_KINDS = [
  "home",
  "service",
  "category",
  "location",
  "pricing",
  "about",
  "contact",
  "other",
];

export interface BusinessEvidence {
  site: { url: string; name: string };
  /** Pages with body text: offer pages first. Ids are "page:<url>". */
  pages: { id: string; url: string; kind: string; title: string; h1: string; text?: string }[];
  /** Product titles: the catalogue as the site lists it. */
  products: { id: string; title: string }[];
  /** Article titles: what customers ask about. */
  articles: { id: string; title: string }[];
  /** Searches the site gets clicks or impressions for (GSC), id "gsc:<query>". */
  gsc: { id: string; query: string; clicks: number; impressions: number }[];
  /** Searches the site ranks for, id "ranked:<query>". */
  ranked: { id: string; query: string; volume: number; cpc?: number }[];
  /** Searches only competitors rank for, id "competitor:<query>": possible offers to ask about. */
  competitor: { id: string; query: string; volume: number }[];
}

export function buildBusinessEvidence(
  ctx: Pick<ClientContext, "site">,
  pages: SitePage[],
  queries: Query[] = [],
  limits: { textPages?: number; textChars?: number; rows?: number } = {},
): BusinessEvidence {
  const textPages = limits.textPages ?? 30;
  const textChars = limits.textChars ?? 1200;
  const rows = limits.rows ?? 40;
  const rank = (k: string) => {
    const i = OFFER_KINDS.indexOf(k);
    return i === -1 ? OFFER_KINDS.length : i;
  };
  const offerPages = pages
    .filter((p) => OFFER_KINDS.includes(p.kind))
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.url.localeCompare(b.url));
  const byVolume = (a: Query, b: Query) => (b.metrics.volume ?? 0) - (a.metrics.volume ?? 0);
  const has = (q: Query, s: string) => q.sources.includes(s as Query["sources"][number]);
  return {
    site: ctx.site,
    pages: offerPages.map((p, i) => ({
      id: `page:${p.url}`,
      url: p.url,
      kind: p.kind,
      title: p.title,
      h1: p.h1,
      ...(i < textPages ? { text: p.text.slice(0, textChars).replace(/\s+/g, " ") } : {}),
    })),
    products: pages
      .filter((p) => p.kind === "product")
      .slice(0, 200)
      .map((p) => ({ id: `page:${p.url}`, title: p.h1 || p.title })),
    articles: pages
      .filter((p) => p.kind === "blog" || p.kind === "guide")
      .slice(0, 60)
      .map((p) => ({ id: `page:${p.url}`, title: p.h1 || p.title })),
    gsc: queries
      .filter((q) => (q.metrics.gscImpressions ?? 0) > 0)
      .sort((a, b) => (b.metrics.gscClicks ?? 0) - (a.metrics.gscClicks ?? 0))
      .slice(0, rows)
      .map((q) => ({
        id: `gsc:${q.normalized}`,
        query: q.text,
        clicks: q.metrics.gscClicks ?? 0,
        impressions: q.metrics.gscImpressions ?? 0,
      })),
    ranked: queries
      .filter((q) => has(q, "dfs_ranked_site"))
      .sort(byVolume)
      .slice(0, rows)
      .map((q) => ({
        id: `ranked:${q.normalized}`,
        query: q.text,
        volume: q.metrics.volume ?? 0,
        ...(q.metrics.cpc !== undefined ? { cpc: q.metrics.cpc } : {}),
      })),
    competitor: queries
      .filter(
        (q) => has(q, "dfs_ranked_competitor") && !has(q, "dfs_ranked_site") && !has(q, "gsc"),
      )
      .sort(byVolume)
      .slice(0, rows)
      .map((q) => ({
        id: `competitor:${q.normalized}`,
        query: q.text,
        volume: q.metrics.volume ?? 0,
      })),
  };
}

const ev = z.array(z.string()).default([]);

/** Models sometimes wrap a plain string in an object ({question}, {name}, {value}, {text}). */
const loose = z.preprocess((x) => {
  if (x && typeof x === "object" && !Array.isArray(x)) {
    const o = x as Record<string, unknown>;
    const s = o.question ?? o.name ?? o.value ?? o.text ?? o.place ?? o.fact;
    return typeof s === "string" ? s : x;
  }
  return x;
}, z.string());
const strings = z
  .array(loose)
  .default([])
  .transform((xs) => xs.map((x) => x.trim()).filter(Boolean));

/** What the model returns; checked and turned into a BusinessProfile by code. */
export const BusinessProposal = z.object({
  offerings: z
    .array(
      z.object({
        name: z.string().min(1),
        kind: z.enum(["service", "product_category", "product_line"]),
        page: z.string().optional(),
        subOfferings: strings,
        attributes: z
          .array(z.object({ name: z.string().min(1), values: z.array(z.string().min(1)).min(1) }))
          .default([]),
        audiences: strings,
        places: strings,
        priceRange: z.string().optional(),
        proofPoints: strings,
        seasonality: z.string().optional(),
        value: z.enum(["top", "normal", "side"]).default("normal"),
        evidence: ev,
      }),
    )
    .min(1),
  notOffered: z
    .array(z.object({ name: z.string().min(1), aliases: strings, evidence: ev }))
    .default([]),
  locations: z
    .array(
      z.object({
        name: z.string().min(1),
        city: z.string().min(1),
        address: z.string().optional(),
        page: z.string().optional(),
        evidence: ev,
      }),
    )
    .default([]),
  serves: z.array(z.object({ place: z.string().min(1), evidence: ev })).default([]),
  nationwide: z.boolean().default(false),
  conversion: z.enum(["book", "quote", "buy", "call", "contact"]).optional(),
  differentiators: z.array(z.object({ fact: z.string().min(1), evidence: ev })).default([]),
  facts: z.array(z.object({ fact: z.string().min(1), evidence: ev })).default([]),
  brand: z
    .object({
      own: strings,
      neverTarget: strings,
    })
    .default({ own: [], neverTarget: [] }),
  siteTerms: z.array(z.object({ term: z.string().min(1), meaning: z.string().min(1) })).default([]),
  openQuestions: strings,
});
export type BusinessProposal = z.infer<typeof BusinessProposal>;

function evidenceText(e: BusinessEvidence): string {
  const out: string[] = [
    `SITE: ${e.site.name} (${e.site.url})`,
    "",
    "PAGES (id | kind | title | h1, then text):",
  ];
  for (const p of e.pages) {
    out.push(`- ${p.id} | ${p.kind} | ${p.title} | ${p.h1}`);
    if (p.text) out.push(`  text: ${p.text}`);
  }
  if (e.products.length) {
    out.push("", "PRODUCTS (id | title):");
    for (const p of e.products) out.push(`- ${p.id} | ${p.title}`);
  }
  if (e.articles.length) {
    out.push("", "ARTICLES (id | title):");
    for (const p of e.articles) out.push(`- ${p.id} | ${p.title}`);
  }
  if (e.gsc.length) {
    out.push("", "SEARCHES THE SITE GETS CLICKS FOR (id | query | clicks | impressions):");
    for (const q of e.gsc) out.push(`- ${q.id} | ${q.query} | ${q.clicks} | ${q.impressions}`);
  }
  if (e.ranked.length) {
    out.push("", "SEARCHES THE SITE RANKS FOR (id | query | monthly volume | cpc):");
    for (const q of e.ranked) out.push(`- ${q.id} | ${q.query} | ${q.volume} | ${q.cpc ?? "?"}`);
  }
  if (e.competitor.length) {
    out.push("", "SEARCHES ONLY COMPETITORS RANK FOR (id | query | monthly volume):");
    for (const q of e.competitor) out.push(`- ${q.id} | ${q.query} | ${q.volume}`);
  }
  return out.join("\n");
}

export function buildBusinessMessages(
  e: BusinessEvidence,
  ctx: Pick<ClientContext, "market" | "sourceContext" | "offerings">,
): { role: "system" | "user"; content: string }[] {
  const lang = languageName(ctx.market.language);
  const system = [
    "You build a precise business profile for an SEO topical map. Every later decision checks against it: which pages may exist, which places are served, which facts a page may claim.",
    "Use only the evidence given. Every item cites the evidence ids that prove it. If nothing proves a field, leave it empty: an empty field is asked to the owner later; a guess is a defect.",
    "Be specific: split broad offers into the sub-offerings the site names, and list attributes the site uses to tell variants apart (type, size, sector, material, location, price class).",
    "Free downloads, guides, demos, intro calls and quotes are how a visitor converts, not what the business sells: put them in conversion, never in offerings.",
    "notOffered only lists what the evidence says the business does NOT do (e.g. 'no home visits'). Never infer it from silence.",
    "Searches only competitors rank for are not facts about this business: turn the ones that look like a real offer into openQuestions ('Do you offer X?'). Never add them as offerings.",
    `Write values in ${lang} (${ctx.market.language}) as the site writes them. Keep names, product names and terms exactly as the evidence uses them.`,
    "Return only JSON.",
  ].join("\n");
  const user = [
    `How the business earns (confirmed): ${ctx.sourceContext}`,
    `Offerings the owner confirmed earlier, in short: ${ctx.offerings.join("; ") || "none"}`,
    "",
    "Return JSON with these keys:",
    '{"offerings": [{"name", "kind": "service"|"product_category"|"product_line", "page": "/its-page/"?, "subOfferings": [string], "attributes": [{"name", "values": [string]}], "audiences": [string], "places": [string], "priceRange"?, "proofPoints": [string], "seasonality"?, "value": "top"|"normal"|"side", "evidence": [ids]}],',
    ' "notOffered": [{"name", "aliases": [string], "evidence": [ids]}], "locations": [{"name", "city", "address"?, "page"?, "evidence": [ids]}], "serves": [{"place", "evidence": [ids]}], "nationwide": bool,',
    ' "conversion": "book"|"quote"|"buy"|"call"|"contact", "differentiators": [{"fact", "evidence": [ids]}], "facts": [{"fact", "evidence": [ids]}], "brand": {"own": [string], "neverTarget": [string]}, "siteTerms": [{"term", "meaning"}], "openQuestions": [string]}',
    "value: top only when the evidence shows it earns most (the main pages, most clicks, highest prices); side when the site barely mentions it; else normal.",
    "places: only where this offering is delivered when that differs from the whole business; nationwide: true for a webshop or a service delivered anywhere.",
    "facts: years in business, certifications, numbers of customers, prices, opening hours: only as the site states them.",
    "siteTerms: words the site uses for its own sections (e.g. what it calls its services or its blog).",
    "",
    "EVIDENCE",
    evidenceText(e),
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** The fields AI couldn't prove: the setup asks these, and only these. */
export function unknownFields(o: Pick<Offering, OfferingField>): OfferingField[] {
  const empty: Record<OfferingField, boolean> = {
    subOfferings: false,
    attributes: o.attributes.length === 0,
    audiences: o.audiences.length === 0,
    places: false,
    priceRange: !o.priceRange,
    proofPoints: o.proofPoints.length === 0,
    seasonality: false,
  };
  return OFFERING_FIELDS.filter((f) => empty[f]);
}

/**
 * What JSON validation can't catch. Evidence ids that don't exist are removed; an item left
 * without proof is dropped (an offering becomes an open question instead). Every removal is listed.
 */
export function toBusinessProfile(
  p: BusinessProposal,
  e: BusinessEvidence,
  ctx: Pick<ClientContext, "market" | "offerings">,
): { profile: BusinessProfile; removed: string[] } {
  const removed: string[] = [];
  const pageKinds = new Map(e.pages.map((x) => [x.id, x.kind]));
  const known = new Set<string>([
    ...e.pages.map((x) => x.id),
    ...e.products.map((x) => x.id),
    ...e.articles.map((x) => x.id),
    ...e.gsc.map((x) => x.id),
    ...e.ranked.map((x) => x.id),
  ]);
  const competitorIds = new Set(e.competitor.map((x) => x.id));
  const sources = (ids: string[], what: string, ownPage?: string): Source[] =>
    ids
      .filter((id) => {
        if (known.has(id)) return true;
        removed.push(
          competitorIds.has(id)
            ? `${what}: a competitor search is not proof ("${id}")`
            : `${what}: unknown evidence "${id}"`,
        );
        return false;
      })
      .map((id) => {
        if (id.startsWith("page:")) {
          const url = id.slice(5);
          const strong =
            url === ownPage ||
            ["service", "category", "location", "pricing"].includes(pageKinds.get(id) ?? "");
          return {
            from: "site" as const,
            ref: url,
            confidence: strong ? ("high" as const) : ("medium" as const),
          };
        }
        return { from: "search" as const, ref: id, confidence: "low" as const };
      });
  const questions = [...p.openQuestions];
  const ids = new Set<string>();
  const offerings: Offering[] = [];
  for (const o of p.offerings) {
    const page = o.page && pageKinds.has(`page:${o.page}`) ? o.page : undefined;
    const src = sources(o.evidence, `offering "${o.name}"`, page);
    if (!src.length) {
      removed.push(`offering "${o.name}" has no proof: asked instead`);
      questions.push(o.name);
      continue;
    }
    let id = slugify(o.name);
    for (let i = 2; ids.has(id); i++) id = `${slugify(o.name)}-${i}`;
    ids.add(id);
    const base = {
      id,
      name: o.name,
      kind: o.kind,
      ...(page ? { page } : {}),
      subOfferings: o.subOfferings.filter(Boolean),
      attributes: o.attributes,
      audiences: o.audiences.filter(Boolean),
      places: o.places.filter(Boolean),
      ...(o.priceRange ? { priceRange: o.priceRange } : {}),
      proofPoints: o.proofPoints.filter(Boolean),
      ...(o.seasonality ? { seasonality: o.seasonality } : {}),
      value: o.value,
      sources: src,
      status: "proposed" as const,
    };
    offerings.push({ ...base, unknown: unknownFields(base) });
  }
  // An offering the owner confirmed earlier but the site doesn't show: ask, don't drop.
  const lang = ctx.market.language;
  const words = offerings.map((o) => tokens([o.name, ...o.subOfferings].join(" "), lang));
  const names = offerings.flatMap((o) => [o.name, ...o.subOfferings].map((s) => tokens(s, lang)));
  for (const o of ctx.offerings) {
    const t = tokens(o, lang);
    if (!t.size) continue;
    // "De Saak DMS voor documentmanagement" is covered by an offering named "De Saak DMS".
    const covered =
      words.some((w) => within(t, w)) || names.some((k) => k.size >= 2 && within(k, t));
    if (!covered) questions.push(o);
  }
  const keep = <T extends { evidence: string[] }>(xs: T[], what: (x: T) => string) =>
    xs
      .map((x) => ({ x, src: sources(x.evidence, what(x)) }))
      .filter(({ x, src }) => {
        if (src.length) return true;
        removed.push(`${what(x)} has no proof: left out`);
        return false;
      });
  if (!offerings.length) throw new Error("no offering has proof in the evidence");
  const profile = BusinessProfile.parse({
    offerings,
    notOffered: keep(p.notOffered, (x) => `not offered "${x.name}"`).map(({ x, src }) => ({
      name: x.name,
      aliases: x.aliases,
      sources: src,
    })),
    places: {
      locations: keep(p.locations, (x) => `location "${x.name}"`).map(({ x }) => ({
        name: x.name,
        city: x.city,
        ...(x.address ? { address: x.address } : {}),
        ...(x.page && pageKinds.has(`page:${x.page}`) ? { page: x.page } : {}),
      })),
      serves: keep(p.serves, (x) => `place "${x.place}"`).map(({ x }) => x.place),
      nationwide: p.nationwide,
    },
    ...(p.conversion ? { conversion: p.conversion } : {}),
    differentiators: keep(p.differentiators, (x) => `differentiator "${x.fact}"`).map(
      ({ x, src }) => ({ fact: x.fact, sources: src }),
    ),
    facts: keep(p.facts, (x) => `fact "${x.fact}"`).map(({ x, src }) => ({
      fact: x.fact,
      sources: src,
    })),
    brand: { own: p.brand.own, neverTarget: p.brand.neverTarget, avoidWords: [] },
    siteTerms: p.siteTerms,
    openQuestions: [...new Set(questions)].map((q) =>
      q.endsWith("?") ? q : `Do you offer "${q}"?`,
    ),
  });
  return { profile, removed };
}

export const BusinessProposeInput = z.object({
  context: z.custom<ClientContext>(),
  pages: z.array(z.custom<SitePage>()).min(1),
  queries: z.array(z.custom<Query>()).default([]),
  model: z.string().min(1),
});

/** The step: site pages and search data in, a proposed business profile out (nothing confirmed). */
export function businessProposeStep(llm: JsonModel) {
  return defineStep({
    name: "business-propose",
    version: BUSINESS_TEMPLATE.version,
    input: BusinessProposeInput,
    output: BusinessProfile,
    maxAttempts: 2,
    async run(input, ctx) {
      const evidence = buildBusinessEvidence(input.context, input.pages, input.queries);
      ctx.log.info("business evidence", {
        pages: evidence.pages.length,
        products: evidence.products.length,
        articles: evidence.articles.length,
        gsc: evidence.gsc.length,
        ranked: evidence.ranked.length,
        competitor: evidence.competitor.length,
      });
      const raw = await llm.generateJson(
        {
          model: input.model,
          template: BUSINESS_TEMPLATE,
          params: { temperature: 0.2, seed: 42 + ctx.attempt },
          messages: buildBusinessMessages(evidence, input.context),
        },
        BusinessProposal,
        ctx,
      );
      const { profile, removed } = toBusinessProfile(raw, evidence, input.context);
      if (removed.length) ctx.log.warn("business proposal cleaned", { removed });
      return profile;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The setup: the owner's answers on top of the proposal.

const owner: Source = { from: "owner", confidence: "high" };

/** Merges the owner's answers into the profile. The owner's word wins; the profile is confirmed. */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const uniq = (xs: string[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => !seen.has(norm(x)) && !!seen.add(norm(x)));
};
/** Keeps the first item per key (case and spacing ignored), folding later duplicates into it. */
function dedupeBy<T>(xs: T[], key: (x: T) => string, fold: (keep: T, dup: T) => T): T[] {
  const out = new Map<string, T>();
  for (const x of xs) {
    const k = norm(key(x));
    const had = out.get(k);
    out.set(k, had ? fold(had, x) : x);
  }
  return [...out.values()];
}

export function applyOwnerAnswers(
  p: BusinessProfile,
  input: z.input<typeof OwnerAnswersSchema>,
): BusinessProfile {
  const a = OwnerAnswersSchema.parse(input);
  const removed = new Set(a.removed);
  const steps = new Set(a.conversionSteps);
  const into = new Map(
    a.merged.filter((m) => m.id !== m.into && !removed.has(m.into)).map((m) => [m.id, m.into]),
  );
  const folded = new Map<string, Offering[]>();
  for (const o of p.offerings) {
    const target = into.get(o.id);
    if (target) folded.set(target, [...(folded.get(target) ?? []), o]);
  }
  const top = new Set(a.top);
  const edits = new Map(a.edits.map((e) => [e.id, e.set]));
  const offerings: Offering[] = [];
  const ids = new Set<string>();
  for (const o of p.offerings) {
    if (removed.has(o.id) || into.has(o.id) || steps.has(o.id)) continue;
    const set = edits.get(o.id);
    const parts = folded.get(o.id) ?? [];
    const merged = { ...o, ...(set ?? {}) } as Offering;
    if (parts.length) {
      merged.subOfferings = uniq([
        ...merged.subOfferings,
        ...parts.flatMap((x) => [x.name, ...x.subOfferings]),
      ]);
      merged.sources = [...merged.sources, ...parts.flatMap((x) => x.sources)];
      if (!top.size && parts.some((x) => x.value === "top")) merged.value = "top";
    }
    const value = top.size
      ? top.has(o.id)
        ? "top"
        : merged.value === "top"
          ? "normal"
          : merged.value
      : merged.value;
    const next = {
      ...merged,
      value,
      sources: set || parts.length ? [...merged.sources, owner] : o.sources,
      status: set || parts.length ? ("edited" as const) : ("confirmed" as const),
    };
    offerings.push({ ...next, unknown: unknownFields(next) });
    ids.add(o.id);
  }
  for (const add of a.added) {
    let id = add.id ?? slugify(add.name ?? "aanbod");
    for (let i = 2; ids.has(id); i++) id = `${add.id ?? slugify(add.name ?? "aanbod")}-${i}`;
    ids.add(id);
    const base = {
      ...add,
      id,
      name: add.name ?? id,
      kind: add.kind ?? "service",
      value:
        top.has(id) || (add.id && top.has(add.id)) ? ("top" as const) : (add.value ?? "normal"),
      sources: [owner],
      status: "added" as const,
    };
    offerings.push({ ...base, unknown: unknownFields(base) } as Offering);
  }
  const notOffered = dedupeBy(
    [
      ...p.notOffered,
      ...p.offerings
        .filter((o) => removed.has(o.id))
        .map((o) => ({ name: o.name, aliases: o.subOfferings, sources: [owner] })),
      ...a.notOffered.map((n) => ({ name: n.name, aliases: n.aliases, sources: [owner] })),
    ],
    (n) => n.name,
    (keep, dup) => ({
      ...keep,
      aliases: uniq([...keep.aliases, ...dup.aliases]),
      sources: [...keep.sources, ...dup.sources],
    }),
  );
  return BusinessProfile.parse({
    ...p,
    offerings,
    notOffered,
    places: {
      locations: a.places?.locations ?? p.places.locations,
      serves: uniq(a.places?.serves ?? p.places.serves),
      nationwide: a.places?.nationwide ?? p.places.nationwide,
    },
    ...(a.conversion ? { conversion: a.conversion } : {}),
    facts: dedupeBy(
      [...p.facts, ...a.facts.map((fact) => ({ fact, sources: [owner] }))],
      (f) => f.fact,
      (keep, dup) => ({ ...keep, sources: [...keep.sources, ...dup.sources] }),
    ),
    brand: {
      own: a.brand?.own ?? p.brand.own,
      neverTarget: a.brand?.neverTarget ?? p.brand.neverTarget,
      avoidWords: a.brand?.avoidWords ?? p.brand.avoidWords,
    },
    openQuestions: [],
    confirmed: { by: a.by, at: a.at },
  });
}

// ---------------------------------------------------------------------------------------------
// Scoring against an answer key, and a simulated owner for the test clients.

const nameKeys = (o: Pick<Offering, "name" | "subOfferings">, lang: string) =>
  [o.name, ...o.subOfferings].map((s) => tokens(s, lang)).filter((t) => t.size > 0);

const within = (a: Set<string>, b: Set<string>) => a.size > 0 && [...a].every((x) => b.has(x));

const sameOffer = (a: Offering, b: Offering, lang: string) => {
  const ta = tokens(a.name, lang);
  const tb = tokens(b.name, lang);
  return (
    nameKeys(a, lang).some((k) => within(k, tb)) || nameKeys(b, lang).some((k) => within(k, ta))
  );
};

/**
 * For the simulated owner only: a proposed word also matches a key word that is a compound ending
 * in it ("planten" ~ "kamerplanten"), never the other way ("bekkenfysiotherapie" is not the
 * owner's "fysiotherapie"). Scoring stays strict.
 */
const like = (proposedWord: string, keyWord: string) =>
  proposedWord === keyWord || (proposedWord.length >= 4 && keyWord.endsWith(proposedWord));
const covered = (keyWords: Set<string>, proposedWords: Set<string>) =>
  keyWords.size > 0 && [...keyWords].every((k) => [...proposedWords].some((p) => like(p, k)));
const covering = (proposedWords: Set<string>, keyWords: Set<string>) =>
  proposedWords.size > 0 && [...proposedWords].every((p) => [...keyWords].some((k) => like(p, k)));

const sameNameLoose = (g: Offering, k: Offering, lang: string) => {
  const tg = tokens(g.name, lang);
  const tk = tokens(k.name, lang);
  return covering(tg, tk) && covered(tk, tg);
};
const sameOfferLoose = (g: Offering, k: Offering, lang: string) => {
  const tg = tokens(g.name, lang);
  const tk = tokens(k.name, lang);
  return (
    nameKeys(g, lang).some((w) => covering(w, tk)) || nameKeys(k, lang).some((w) => covered(w, tg))
  );
};

/** Share of fields filled per offering: how specific the profile is. */
export function specificity(o: Offering): number {
  const filled = [
    o.subOfferings.length > 0,
    o.attributes.length > 0,
    o.audiences.length > 0,
    !!o.priceRange,
    o.proofPoints.length > 0,
    !!o.page,
  ];
  return filled.filter(Boolean).length / filled.length;
}

export interface ProfileScore {
  offerings: { recall: number; precision: number; missed: string[]; extra: string[] };
  notOffered: { recall: number | null; missed: string[] };
  places: { recall: number | null; missed: string[] };
  specificity: number;
  unknownFields: number;
  openQuestions: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** How close a proposed profile is to the answer key (hand-filled from the client's brief). */
export function scoreProfile(
  got: BusinessProfile,
  key: BusinessProfile,
  language: string,
): ProfileScore {
  const found = key.offerings.filter((k) => got.offerings.some((g) => sameOffer(g, k, language)));
  const real = got.offerings.filter((g) => key.offerings.some((k) => sameOffer(g, k, language)));
  const t = (s: string) => tokens(s, language);
  const coversName = (words: string[], target: string) =>
    words.some((w) => {
      const a = t(w);
      const b = t(target);
      return a.size > 0 && ([...a].every((x) => b.has(x)) || [...b].every((x) => a.has(x)));
    });
  const gotNo = got.notOffered.flatMap((n) => [n.name, ...n.aliases]);
  const noMissed = key.notOffered.filter((n) => !coversName(gotNo, n.name)).map((n) => n.name);
  const keyPlaces = [...key.places.locations.map((l) => l.name), ...key.places.serves];
  const gotPlaces = [
    ...got.places.locations.flatMap((l) => [l.name, l.city]),
    ...got.places.serves,
  ];
  const placesMissed = keyPlaces.filter((p) => !coversName(gotPlaces, p));
  return {
    offerings: {
      recall: round(found.length / key.offerings.length),
      precision: got.offerings.length ? round(real.length / got.offerings.length) : 0,
      missed: key.offerings.filter((k) => !found.includes(k)).map((k) => k.name),
      extra: got.offerings.filter((g) => !real.includes(g)).map((g) => g.name),
    },
    notOffered: {
      recall: key.notOffered.length
        ? round((key.notOffered.length - noMissed.length) / key.notOffered.length)
        : null,
      missed: noMissed,
    },
    places: {
      recall: keyPlaces.length
        ? round((keyPlaces.length - placesMissed.length) / keyPlaces.length)
        : null,
      missed: placesMissed,
    },
    specificity: round(
      got.offerings.reduce((s, o) => s + specificity(o), 0) / Math.max(1, got.offerings.length),
    ),
    unknownFields: got.offerings.reduce((s, o) => s + o.unknown.length, 0),
    openQuestions: got.openQuestions.length,
  };
}

/**
 * Plays the owner of a test client from its answer key: removes what the key doesn't offer, fills
 * every unknown field from the key, adds what the AI missed and names the key's top offerings.
 * Deterministic, so a blind client's answers are fixed before any run (issue #42).
 */
export function simulateOwner(
  proposed: BusinessProfile,
  key: BusinessProfile,
  language: string,
  by = "simulated owner (answer key)",
  at = "2026-11-15T00:00:00.000Z",
): OwnerAnswers {
  const removed: string[] = [];
  const merged: OwnerAnswers["merged"] = [];
  const edits: OwnerAnswers["edits"] = [];
  const top: string[] = [];
  // Which proposed offering stands for each key offering: same name first, then any overlap.
  const heldBy = new Map<Offering, Offering>();
  const rest: Offering[] = [];
  const exact = (g: Offering, x: Offering) =>
    variantKey(g.name, language) === variantKey(x.name, language);
  const loose: Offering[] = [];
  for (const g of proposed.offerings) {
    const k = key.offerings.find((x) => !heldBy.has(x) && exact(g, x));
    if (k) heldBy.set(k, g);
    else loose.push(g);
  }
  for (const g of loose) {
    const k = key.offerings.find((x) => !heldBy.has(x) && sameNameLoose(g, x, language));
    if (k) heldBy.set(k, g);
    else rest.push(g);
  }
  for (const g of rest) {
    const k = key.offerings.find((x) => sameOfferLoose(g, x, language));
    const holder = k && heldBy.get(k);
    if (!k) removed.push(g.id);
    else if (holder) merged.push({ id: g.id, into: holder.id });
    else heldBy.set(k, g);
  }
  for (const [k, g] of heldBy) {
    const set: OwnerAnswers["edits"][number]["set"] = {};
    for (const f of g.unknown) {
      if (f === "attributes" && k.attributes.length) set.attributes = k.attributes;
      if (f === "audiences" && k.audiences.length) set.audiences = k.audiences;
      if (f === "priceRange" && k.priceRange) set.priceRange = k.priceRange;
      if (f === "proofPoints" && k.proofPoints.length) set.proofPoints = k.proofPoints;
    }
    if (Object.keys(set).length) edits.push({ id: g.id, set });
    if (k.value === "top") top.push(g.id);
  }
  const matched = new Set(heldBy.keys());
  const added = key.offerings
    .filter((k) => !matched.has(k))
    .map(({ sources: _s, status: _st, unknown: _u, ...rest }) => rest);
  for (const k of key.offerings) if (!matched.has(k) && k.value === "top") top.push(k.id);
  return {
    by,
    at,
    removed,
    conversionSteps: [],
    merged,
    edits,
    added,
    top,
    notOffered: key.notOffered.map((n) => ({ name: n.name, aliases: n.aliases })),
    places: key.places,
    ...(key.conversion ? { conversion: key.conversion } : {}),
    facts: key.facts.map((f) => f.fact).filter((f) => !proposed.facts.some((p) => p.fact === f)),
    brand: key.brand,
  };
}
