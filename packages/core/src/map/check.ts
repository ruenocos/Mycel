import type { BusinessProfile, ClientContext } from "@mycel/schema";
import { z } from "zod";
import type { JsonModel } from "../context/llm.ts";
import type { StepContext } from "../log/run-store.ts";
import { type NodeDraft, type NodeLabel, tokens } from "./plan.ts";
import { CLAIMS } from "./rules.ts";
import { stageOf } from "./value.ts";

/**
 * The fact check (issue #42, step 7). After labelling, every name and why-text the model wrote is
 * checked against the business profile: a place, price or service it claims must be in the
 * profile, praise needs a fact behind it, and SEO jargon doesn't reach the owner. A text that
 * fails is rewritten by the model once; if it still fails, a plain sentence built from the data
 * takes its place. Nothing here takes facts from the model: it only rewrites with what is given.
 */

export const FIX_TEMPLATE = { id: "map-fix", version: "1" } as const;

/** What a text may claim: the profile, the market and the page's own searches. */
export interface ClaimFacts {
  language: string;
  country: string;
  city?: string;
  siteName: string;
  business?: BusinessProfile;
  /** The page's searches: a word a visitor searched for may be named. */
  searches: string[];
}

export function claimFacts(ctx: ClientContext, searches: string[]): ClaimFacts {
  return {
    language: ctx.market.language,
    country: ctx.market.country,
    ...(ctx.market.city ? { city: ctx.market.city } : {}),
    siteName: ctx.site.name,
    ...(ctx.business ? { business: ctx.business } : {}),
    searches,
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasTerm = (text: string, term: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, "iu").test(text);

/** The market country's name in the market language ("Nederland"); the code is validated. */
const countryName = (country: string, language: string) =>
  new Intl.DisplayNames([language], { type: "region" }).of(country);

/** Problems with one text, in plain English for the fix prompt and the logs. Empty: it passes. */
export function checkText(text: string, f: ClaimFacts): string[] {
  const rules = CLAIMS[f.language] ?? CLAIMS.en;
  if (!rules || !text.trim()) return [];
  const problems: string[] = [];
  const b = f.business;
  const factText = [
    ...(b?.facts ?? []).map((x) => x.fact),
    ...(b?.differentiators ?? []).map((x) => x.fact),
    ...(b?.offerings ?? []).flatMap((o) => [...o.proofPoints, o.priceRange ?? ""]),
  ].join(" \n ");
  const words = tokens(text, f.language);
  const covers = (s: string) => {
    const t = tokens(s, f.language);
    return t.size > 0 && [...t].every((w) => words.has(w));
  };

  for (const s of rules.superlatives) {
    if (hasTerm(text, s) && !hasTerm(factText, s)) problems.push(`unproven praise "${s}"`);
  }
  for (const j of rules.jargon) {
    if (hasTerm(text, j)) problems.push(`SEO jargon "${j}"`);
  }
  for (const m of text.matchAll(/€\s?(\d[\d.,]*)|(\d[\d.,]*)\s?(?:euro|eur)\b/giu)) {
    const amount = (m[1] ?? m[2] ?? "").replace(/[.,]$/, "");
    if (amount && !factText.includes(amount)) problems.push(`price ${amount} not in the profile`);
  }
  for (const x of b?.notOffered ?? []) {
    if ([x.name, ...x.aliases].some(covers)) problems.push(`"${x.name}" is not offered`);
  }
  for (const x of [...(b?.brand.neverTarget ?? []), ...(b?.brand.avoidWords ?? [])]) {
    if (covers(x)) problems.push(`"${x}" is a word the business doesn't use`);
  }

  // Places: only for a business with a service area; a nationwide one claims no place.
  if (b && !b.places.nationwide) {
    const allowed = [
      ...b.places.serves,
      ...b.places.locations.flatMap((l) => [l.name, l.city]),
      ...(f.city ? [f.city] : []),
      countryName(f.country, f.language) ?? "",
      f.siteName,
      ...b.offerings.map((o) => o.name),
      ...b.brand.own,
    ]
      .filter(Boolean)
      .map((p) => p.toLowerCase());
    const searched = tokens(f.searches.join(" "), f.language);
    const known = (place: string) => {
      const low = place.toLowerCase();
      if (allowed.some((a) => a === low || a.includes(low) || low.includes(a))) return true;
      const t = tokens(place, f.language);
      return t.size > 0 && [...t].every((w) => searched.has(w));
    };
    const own = b.places.locations.flatMap((l) => [l.name, l.city]).map((p) => p.toLowerCase());
    for (const m of text.matchAll(rules.ownPlace)) {
      const place = m[1] ?? "";
      if (!own.some((o) => o === place.toLowerCase())) {
        problems.push(`claims an own location in "${place}"`);
      }
    }
    for (const m of text.matchAll(rules.inPlace)) {
      const place = m[1] ?? "";
      if (place && !known(place)) problems.push(`names "${place}", a place not served`);
    }
  }
  return [...new Set(problems)];
}

/** Plain sentences built from data, in the market language, when the model's text fails. */
const PLAIN: Record<
  string,
  {
    demand: (q: string, v: number) => string;
    quiet: (q: string) => string;
    stage: Record<ReturnType<typeof stageOf>, string>;
    offering: (name: string) => string;
    hub: { offering: string; site: string; theme: string };
  }
> = {
  nl: {
    demand: (q, v) =>
      `Op "${q}" wordt ongeveer ${v.toLocaleString("nl-NL")} keer per maand gezocht`,
    quiet: (q) => `Op "${q}" wordt nog weinig gezocht`,
    stage: {
      buy: "door mensen die willen kopen of boeken.",
      compare: "door mensen die opties en prijzen vergelijken.",
      learn: "door mensen met een vraag die deze pagina beantwoordt.",
      find: "door mensen die een bepaalde naam zoeken.",
    },
    offering: (name) => ` De pagina hoort bij ${name}.`,
    hub: {
      offering: "Een van je eigen diensten of producten: elk aanbod krijgt een eigen pagina.",
      site: "Een onderdeel dat je site al heeft; het blijft de plek voor pagina's die erbij horen.",
      theme: "Een overzichtspagina die pagina's over één thema bij elkaar zet.",
    },
  },
  en: {
    demand: (q, v) => `"${q}" is searched about ${v.toLocaleString("en-GB")} times a month`,
    quiet: (q) => `"${q}" is searched rarely so far`,
    stage: {
      buy: "by people who want to buy or book.",
      compare: "by people comparing options and prices.",
      learn: "by people with a question this page answers.",
      find: "by people looking for a specific name.",
    },
    offering: (name) => ` The page belongs to ${name}.`,
    hub: {
      offering: "One of your own offerings: every offering gets its own page.",
      site: "A section your site already has; it stays the home for related pages.",
      theme: "An overview page that brings pages on one theme together.",
    },
  },
};

/** A why-text from data only: demand, buying stage and the offering it serves. */
export function plainWhy(
  n: Pick<NodeDraft, "mainQuery" | "volume" | "intent" | "hub">,
  language: string,
  offeringName?: string,
): string {
  const t = PLAIN[language] ?? (PLAIN.en as (typeof PLAIN)[string]);
  if (n.hub) return t.hub[n.hub];
  const head = n.volume > 0 ? t.demand(n.mainQuery, n.volume) : t.quiet(n.mainQuery);
  return `${head} ${t.stage[stageOf(n.intent.main)]}${offeringName ? t.offering(offeringName) : ""}`;
}

/** A name from data only: the main search with a capital. */
export const plainName = (mainQuery: string) =>
  mainQuery.charAt(0).toUpperCase() + mainQuery.slice(1);

export const FixAnswer = z.object({
  results: z.array(z.object({ i: z.number().int().nonnegative(), text: z.string() })),
});
export type FixAnswer = z.infer<typeof FixAnswer>;

export function buildFixMessages(
  ctx: ClientContext,
  items: { kind: "name" | "why"; text: string; problems: string[]; searches: string[] }[],
) {
  const b = ctx.business;
  const facts = {
    business: ctx.site.name,
    offerings: b?.offerings.map((o) => o.name) ?? ctx.offerings,
    notOffered: b?.notOffered.map((x) => x.name) ?? [],
    placesServed: b?.places.nationwide
      ? "nationwide"
      : [...(b?.places.serves ?? []), ...(ctx.market.city ? [ctx.market.city] : [])],
    ownLocations: b?.places.locations.map((l) => `${l.name} (${l.city})`) ?? [],
    facts: [...(b?.facts ?? []), ...(b?.differentiators ?? [])].map((f) => f.fact),
  };
  const system = [
    "You fix short texts on a business's website plan that broke a rule.",
    "Rewrite each numbered text so it has none of its listed problems. Keep its meaning, its language and about its length.",
    "Use only the business facts given: name no place, price, service or quality claim that is not in them. Drop a claim rather than guess.",
    "Write for the business owner in plain words: no SEO terms (search intent, cluster, hub, core or outer page, SERP).",
    'A "name" is a short page title; a "why" is one or two sentences on why the page is worth making.',
    'Answer with JSON: {"results":[{"i":0,"text":"..."}]}. Answer every number exactly once.',
  ].join("\n");
  const list = items.map((it, i) => ({ i, ...it }));
  return [
    { role: "system" as const, content: system },
    {
      role: "user" as const,
      content: `Business facts:\n${JSON.stringify(facts, null, 1)}\n\nTexts:\n${JSON.stringify(list, null, 1)}`,
    },
  ];
}

/**
 * Checks the model's names and why-texts and asks the model once to fix the ones that fail.
 * A fix that still fails is dropped from the label, so the finish uses the plain data sentence.
 * Changes the labels in place; returns the counts for the log.
 */
export async function checkLabels(
  llm: JsonModel,
  ctx: ClientContext,
  drafts: NodeDraft[],
  labels: Map<string, NodeLabel>,
  opts: { model: string },
  step: StepContext,
): Promise<{ checked: number; failed: number; fixed: number; plain: number }> {
  const items: {
    id: string;
    kind: "name" | "why";
    text: string;
    problems: string[];
    searches: string[];
  }[] = [];
  let checked = 0;
  for (const n of drafts) {
    const label = labels.get(n.id);
    if (!label || label.drop) continue;
    const searches = [n.mainQuery, ...n.queries];
    const facts = claimFacts(ctx, searches);
    for (const kind of ["name", "why"] as const) {
      const text = label[kind]?.trim();
      if (!text) continue;
      checked++;
      const problems = checkText(text, facts);
      if (problems.length) items.push({ id: n.id, kind, text, problems, searches });
    }
  }
  let fixed = 0;
  let plain = 0;
  if (items.length) {
    const answer = await llm.generateJson(
      {
        model: opts.model,
        template: FIX_TEMPLATE,
        messages: buildFixMessages(
          ctx,
          items.map(({ kind, text, problems, searches }) => ({ kind, text, problems, searches })),
        ),
        params: { temperature: 0, seed: 43 },
      },
      FixAnswer,
      step,
    );
    const byI = new Map(answer.results.map((r) => [r.i, r.text.trim()]));
    const draftOf = new Map(drafts.map((n) => [n.id, n]));
    items.forEach((it, i) => {
      const label = labels.get(it.id) as NodeLabel;
      const text = byI.get(i);
      const n = draftOf.get(it.id) as NodeDraft;
      const ok = text && checkText(text, claimFacts(ctx, [n.mainQuery, ...n.queries])).length === 0;
      if (ok) {
        label[it.kind] = text;
        fixed++;
      } else {
        delete label[it.kind];
        plain++;
      }
    });
    step.log.info("fact check", {
      checked,
      failed: items.length,
      fixed,
      plain,
      examples: items.slice(0, 8).map((it) => ({ text: it.text, problems: it.problems })),
    });
  } else {
    step.log.info("fact check", { checked, failed: 0 });
  }
  return { checked, failed: items.length, fixed, plain };
}
