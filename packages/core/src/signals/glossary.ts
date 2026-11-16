import type {
  ClientContext,
  EntityCheck,
  FilteredQuery,
  GlossaryEntry,
  WikidataRef,
} from "@mycel/schema";
import { z } from "zod";
import { STOPWORDS, stemToken } from "../cluster/cluster.ts";
import type { JsonModel } from "../context/llm.ts";
import { canonical } from "../filter/rules.ts";
import { QUESTION_WORDS } from "../map/rules.ts";
import { GLOSSARY, MODIFIERS } from "./rules.ts";

/**
 * Koray steps 3 and 7 (issue #63). The domain's terms come from the searches (data first); what
 * a term means, its other names and its broader terms and parts come from Wikidata, never from
 * the model's memory. The model only picks which Wikidata candidate means the term as this
 * business uses it ("ERP" the software, not "Erp" the village), or none.
 */

export const PICK_TEMPLATE = { id: "wikidata-pick", version: "1" } as const;

// biome-ignore lint/suspicious/noExplicitAny: the recorder shape belongs to connectors; core passes its StepContext
type Rec = any;

export interface HitLike {
  id: string;
  label: string;
  description?: string;
  matched?: string;
}

export interface EntityLike {
  id: string;
  label?: string;
  description?: string;
  aliases: string[];
  broader: string[];
  parts: string[];
  partOf: string[];
  wikipedia?: string;
}

/** What core needs from Wikidata. WikidataClient satisfies it structurally. */
export interface WikidataPort {
  search(term: string, language: string, rec: Rec): Promise<HitLike[]>;
  entities(ids: string[], language: string, rec: Rec): Promise<EntityLike[]>;
}

export interface TermCandidate {
  term: string;
  /** Stems, for matching a term in other texts. */
  key: string;
  queries: number;
  volume: number;
  /** Indexes of the searches it is in. */
  in: Set<number>;
}

/** Stems of a text's words, without stopwords: how terms are matched. */
export const termKey = (text: string, language: string) =>
  canonical(text)
    .split(" ")
    .filter((w) => w && !(STOPWORDS[language] ?? new Set()).has(w))
    .map((w) => stemToken(w, language))
    .join(" ");

/**
 * Domain terms from the kept searches: single words and word pairs that are not a stopword,
 * question word, buying word, place, number or the site's own name, in at least three searches.
 * The central entities and offerings are always in. One spelling per term: the most searched.
 */
export function termCandidates(context: ClientContext, queries: FilteredQuery[]): TermCandidate[] {
  const language = context.market.language;
  const skip = new Set([
    ...(STOPWORDS[language] ?? []),
    ...(QUESTION_WORDS[language] ?? []),
    ...(MODIFIERS[language] ?? []),
    ...canonical(context.market.city ?? "").split(" "),
    ...canonical(context.site.name).split(" "),
  ]);
  const kept = queries.filter((q) => q.filter?.kept);
  const byKey = new Map<string, TermCandidate & { forms: Map<string, number> }>();
  const add = (form: string, i: number, volume: number) => {
    const key = termKey(form, language);
    if (!key) return;
    const c = byKey.get(key) ?? {
      term: form,
      key,
      queries: 0,
      volume: 0,
      in: new Set(),
      forms: new Map(),
    };
    if (!c.in.has(i)) {
      c.in.add(i);
      c.queries++;
      c.volume += volume;
    }
    c.forms.set(form, (c.forms.get(form) ?? 0) + volume + 1);
    byKey.set(key, c);
  };
  kept.forEach((q, i) => {
    const words = canonical(q.normalized).split(" ");
    const ok = words.map((w) => w.length >= 3 && !/\d/.test(w) && !skip.has(w));
    const v = q.metrics.volume ?? 0;
    words.forEach((w, j) => {
      if (!ok[j]) return;
      add(w, i, v);
      if (ok[j + 1]) add(`${w} ${words[j + 1]}`, i, v);
    });
  });
  const must = new Set(
    [
      ...context.centralEntities.map((e) => e.name),
      ...context.offerings,
      ...(context.business?.offerings.map((o) => o.name) ?? []),
    ].map((t) => termKey(t, language)),
  );
  for (const t of [
    ...context.centralEntities.map((e) => e.name),
    ...(context.business?.offerings.map((o) => o.name) ?? context.offerings),
  ]) {
    const key = termKey(t, language);
    if (key && !byKey.has(key)) {
      byKey.set(key, {
        term: canonical(t),
        key,
        queries: 0,
        volume: 0,
        in: new Set(),
        forms: new Map(),
      });
    }
  }
  const list = [...byKey.values()]
    .filter((c) => must.has(c.key) || c.queries >= GLOSSARY.minQueries)
    .map(({ forms, ...c }) => ({
      ...c,
      term: [...forms.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? c.term,
    }));
  // A pair that holds nearly every search of one of its words makes that word say nothing new.
  const pairs = list.filter((c) => c.key.includes(" "));
  const useful = list.filter(
    (c) =>
      must.has(c.key) ||
      c.key.includes(" ") ||
      !pairs.some((p) => p.key.split(" ").includes(c.key) && p.queries >= 0.8 * c.queries),
  );
  const score = (c: TermCandidate) => c.queries * Math.log10(c.volume + 10);
  return useful
    .sort((a, b) => Number(must.has(b.key)) - Number(must.has(a.key)) || score(b) - score(a))
    .slice(0, GLOSSARY.max);
}

export const PickAnswer = z.object({
  results: z.array(z.object({ i: z.number().int().nonnegative(), id: z.string() })),
});

/**
 * The model picks, per term, the candidate that means it as this business uses it, or "none".
 * It sees only the given candidates (label and description); it adds no facts.
 */
export async function pickItems(
  llm: JsonModel,
  context: ClientContext,
  items: { term: string; candidates: HitLike[] }[],
  opts: { model: string },
  rec: Rec,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entity = context.centralEntities[0];
  const system = [
    "You match terms from a business's search data to Wikidata items.",
    'For each numbered term, choose the candidate id that means the term the way this business and its customers use it, or "none" when no candidate does.',
    "Use only the candidates given; a candidate about a place, person, film or other thing with the same name is not a match unless the business is about that.",
    'Answer with JSON: {"results":[{"i":0,"id":"Q123"}]}. Answer every number exactly once.',
  ].join("\n");
  const business = {
    site: context.site.name,
    sourceContext: context.sourceContext,
    centralEntity: entity?.name,
    meaning: entity?.disambiguation,
    notThis: entity?.notThis ?? [],
  };
  for (let s = 0; s < items.length; s += GLOSSARY.batch) {
    const batch = items.slice(s, s + GLOSSARY.batch).filter((x) => x.candidates.length);
    if (!batch.length) continue;
    const list = batch.map((x, i) => ({
      i,
      term: x.term,
      candidates: x.candidates.map((c) => ({
        id: c.id,
        label: c.label,
        description: c.description ?? "",
      })),
    }));
    const answer = await llm.generateJson(
      {
        model: opts.model,
        template: PICK_TEMPLATE,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: `Business:\n${JSON.stringify(business, null, 1)}\n\nTerms:\n${JSON.stringify(list, null, 1)}`,
          },
        ],
        params: { temperature: 0, seed: 63 },
      },
      PickAnswer,
      rec,
    );
    for (const r of answer.results) {
      const item = batch[r.i];
      // Only an id that was offered counts.
      if (item?.candidates.some((c) => c.id === r.id)) out.set(item.term, r.id);
    }
  }
  return out;
}

/** Without a model: the one candidate whose label or matched name is exactly the term. */
export function pickExact(items: { term: string; candidates: HitLike[] }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const x of items) {
    const exact = x.candidates.filter(
      (c) =>
        canonical(c.label) === canonical(x.term) ||
        (c.matched && canonical(c.matched) === canonical(x.term)),
    );
    if (exact.length === 1 && exact[0]) out.set(x.term, exact[0].id);
  }
  return out;
}

const ref = (e: EntityLike): WikidataRef => ({
  id: e.id,
  ...(e.label ? { label: e.label } : {}),
  ...(e.description ? { description: e.description } : {}),
  ...(e.wikipedia ? { wikipedia: e.wikipedia } : {}),
});

/** Step 3: the central entity's check, from its picked item (or none). */
export function entityCheck(
  name: string,
  e: EntityLike | undefined,
  searched: boolean,
): EntityCheck {
  if (!e) {
    return {
      name,
      recognized: false,
      aliases: [],
      broader: [],
      note: searched
        ? "Wikidata has no item that means this entity as the business uses it: the homepage and the hub pages must define it plainly, with its attributes, so search engines learn what it is."
        : "Not checked: Wikidata could not be reached.",
    };
  }
  return {
    name,
    recognized: true,
    wikidata: ref(e),
    aliases: e.aliases,
    broader: e.broader,
    note: e.wikipedia
      ? "A known thing with its own Wikipedia article: pages can lean on that meaning."
      : "Known to Wikidata, without a Wikipedia article in this language: define it plainly on the hub.",
  };
}

/** Step 7: glossary entries from the terms, their picked items and the searches. */
export function buildGlossary(input: {
  terms: TermCandidate[];
  picked: Map<string, string>;
  entities: Map<string, EntityLike>;
  queries: FilteredQuery[];
  language: string;
}): GlossaryEntry[] {
  const kept = input.queries.filter((q) => q.filter?.kept);
  const searchedKeys = new Set<string>();
  for (const q of kept) {
    const words = canonical(q.normalized).split(" ");
    for (let i = 0; i < words.length; i++) {
      for (let j = i + 1; j <= Math.min(words.length, i + 3); j++) {
        searchedKeys.add(termKey(words.slice(i, j).join(" "), input.language));
      }
    }
  }
  return input.terms.map((t) => {
    const id = input.picked.get(t.term);
    const e = id ? input.entities.get(id) : undefined;
    const synonyms = (e?.aliases ?? []).filter((a) => termKey(a, input.language) !== t.key);
    const related = input.terms
      .filter((o) => o !== t && !o.key.split(" ").every((w) => t.key.split(" ").includes(w)))
      .map((o) => ({ o, both: [...o.in].filter((i) => t.in.has(i)).length }))
      .filter((x) => x.both >= 2)
      .sort((a, b) => b.both - a.both)
      .slice(0, 3)
      .map((x) => x.o.term);
    return {
      term: t.term,
      queries: t.queries,
      volume: t.volume,
      ...(e ? { wikidata: ref(e) } : {}),
      synonyms,
      searchedAs: synonyms.filter((s) => searchedKeys.has(termKey(s, input.language))),
      broader: e?.broader ?? [],
      parts: e?.parts ?? [],
      partOf: e?.partOf ?? [],
      related,
    };
  });
}

/** Glossary terms in a page's searches, then the other names people searched (step 12.1). */
export function pageTerms(
  searches: string[],
  glossary: GlossaryEntry[],
  language: string,
): string[] {
  const keys = new Set<string>();
  for (const q of searches) {
    const words = termKey(q, language).split(" ");
    for (let i = 0; i < words.length; i++) {
      keys.add(words[i] as string);
      if (words[i + 1]) keys.add(`${words[i]} ${words[i + 1]}`);
    }
  }
  const out: string[] = [];
  for (const g of glossary) {
    const k = termKey(g.term, language);
    if (!keys.has(k) && !k.split(" ").every((w) => keys.has(w))) continue;
    out.push(g.term, ...g.searchedAs, ...g.synonyms.slice(0, 1));
  }
  return [...new Set(out)].slice(0, GLOSSARY.perPage);
}
