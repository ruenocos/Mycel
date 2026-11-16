import type {
  BusinessProfile,
  ClientContext,
  Cluster,
  FilteredQuery,
  Persona,
  PersonaStage,
} from "@mycel/schema";
import { z } from "zod";
import { STOPWORDS, stemToken } from "../cluster/cluster.ts";
import type { JsonModel } from "../context/llm.ts";
import { canonical } from "../filter/rules.ts";
import { checkText, claimFacts } from "../map/check.ts";
import { QUESTION_WORDS } from "../map/rules.ts";
import { AUDIENCE_NOISE, MODIFIERS, PERSONAS } from "./rules.ts";

/**
 * Koray step 1 (issue #63): the people behind the searches. Data first: the model only groups
 * searches it is shown into personas and names them; a persona counts only with searches that
 * prove it, its stage comes from those searches' intents, and its text passes the claim check.
 * Without a model, each context audience whose words show up in three or more searches is one.
 */

export const PERSONA_TEMPLATE = { id: "personas", version: "1" } as const;

// biome-ignore lint/suspicious/noExplicitAny: the recorder shape belongs to connectors; core passes its StepContext
type Rec = any;

type Offering = BusinessProfile["offerings"][number];

const STAGE: Record<string, PersonaStage> = {
  informational: "learn",
  commercial: "compare",
  transactional: "buy",
  navigational: "buy",
  local: "local",
};

const volumeOf = (q: FilteredQuery) => q.metrics.volume ?? 0;

/** Where a group of searches is: the stage most of their volume points at. */
export function personaStage(queries: FilteredQuery[]): PersonaStage {
  const sum = new Map<PersonaStage, number>();
  for (const q of queries) {
    const s = q.intent ? STAGE[q.intent] : undefined;
    if (s) sum.set(s, (sum.get(s) ?? 0) + volumeOf(q) + 1);
  }
  return [...sum.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "learn";
}

const stems = (text: string, language: string) =>
  canonical(text)
    .split(" ")
    .filter(Boolean)
    .map((w) => stemToken(w, language));

/** Words that say nothing about who searches: stopwords, buying and question words, the core topic. */
function commonStems(context: ClientContext): Set<string> {
  const language = context.market.language;
  const words = [
    ...(STOPWORDS[language] ?? []),
    ...(QUESTION_WORDS[language] ?? []),
    ...(MODIFIERS[language] ?? []),
    ...(AUDIENCE_NOISE[language] ?? []),
    ...canonical(context.market.city ?? "").split(" "),
    ...canonical(context.site.name).split(" "),
    ...context.centralEntities.flatMap((e) => canonical(e.name).split(" ")),
    ...context.offerings.flatMap((o) => canonical(o).split(" ")),
    ...(context.business?.offerings ?? []).flatMap((o) => canonical(o.name).split(" ")),
  ];
  return new Set(words.filter(Boolean).map((w) => stemToken(w, language)));
}

/** The words of an audience that can show up in a search ("sporters", "kantoor"). */
export function audienceStems(audience: string, context: ClientContext): string[] {
  const common = commonStems(context);
  const language = context.market.language;
  return [
    ...new Set(
      canonical(audience)
        .split(" ")
        .filter((w) => w.length >= 4 && !/\d/.test(w))
        .map((w) => stemToken(w, language))
        .filter((s) => !common.has(s)),
    ),
  ];
}

const audiencesOf = (context: ClientContext) => [
  ...new Set([
    ...context.audiences,
    ...(context.business?.offerings ?? []).flatMap((o) => o.audiences),
  ]),
];

const isQuestion = (q: FilteredQuery, language: string) =>
  q.sources.includes("serp_paa") ||
  (QUESTION_WORDS[language] ?? new Set()).has(canonical(q.normalized).split(" ")[0] ?? "");

/**
 * The searches the model sees: ones with an audience's words first, then questions (they say
 * most about a situation), then the most searched. Kept searches only.
 */
export function personaPool(context: ClientContext, queries: FilteredQuery[]): FilteredQuery[] {
  const language = context.market.language;
  const kept = queries.filter((q) => q.filter?.kept).sort((a, b) => volumeOf(b) - volumeOf(a));
  const marks = new Set(audiencesOf(context).flatMap((a) => audienceStems(a, context)));
  const out = new Map<string, FilteredQuery>();
  const take = (list: FilteredQuery[], n: number) => {
    let added = 0;
    for (const q of list) {
      if (out.size >= PERSONAS.pool || added >= n) break;
      if (out.has(q.normalized)) continue;
      out.set(q.normalized, q);
      added++;
    }
  };
  take(
    kept.filter((q) => stems(q.normalized, language).some((s) => marks.has(s))),
    PERSONAS.poolAudience,
  );
  take(
    kept.filter((q) => isQuestion(q, language)),
    PERSONAS.poolQuestions,
  );
  take(kept, PERSONAS.pool);
  return [...out.values()];
}

export const PersonaAnswer = z.object({
  personas: z.array(
    z.object({
      name: z.string(),
      who: z.string(),
      audience: z.string().nullable().optional(),
      needs: z.array(z.string()).default([]),
      evidence: z.array(z.number().int().nonnegative()),
      offerings: z.array(z.string()).default([]),
    }),
  ),
});
export type PersonaDraft = z.infer<typeof PersonaAnswer>["personas"][number];

const languageName = (code: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    // An unknown code is shown as is; the prompt still works.
    return code;
  }
};

/** The model groups the shown searches into personas. It adds no facts: the checks below. */
export async function proposePersonas(
  llm: JsonModel,
  context: ClientContext,
  pool: FilteredQuery[],
  opts: { model: string },
  rec: Rec,
): Promise<PersonaDraft[]> {
  const lang = languageName(context.market.language);
  const system = [
    "You find the groups of people (personas) behind a business's search data.",
    "Group the numbered searches by the person who makes them: their situation and goal, not the topic alone.",
    `Make 2 to ${PERSONAS.max} personas; fewer is better than overlapping ones.`,
    "For each persona give:",
    `- name: a short label for the group in ${lang}, a role or situation, never an invented personal name;`,
    `- who: one plain sentence in ${lang}: who they are and what they want;`,
    "- audience: the business audience it matches, copied exactly from the list, or null;",
    `- needs: 2 to 4 short phrases in ${lang}, taken from their searches;`,
    `- evidence: the numbers of at least ${PERSONAS.minEvidence} searches this persona makes and the others do not;`,
    "- offerings: the ids of the offerings they are after (may be empty).",
    "Use only the searches given. Do not add facts about the business, prices, places or numbers.",
    'Answer with JSON: {"personas":[{"name":"...","who":"...","audience":null,"needs":["..."],"evidence":[0,4,9],"offerings":[]}]}',
  ].join("\n");
  const business = {
    site: context.site.name,
    sourceContext: context.sourceContext,
    centralEntity: context.centralEntities[0]?.name,
    audiences: audiencesOf(context),
    offerings: (context.business?.offerings ?? []).map((o) => ({ id: o.id, name: o.name })),
  };
  const searches = pool
    .map((q, i) => `${i}. ${q.normalized} (${volumeOf(q)}${q.intent ? `, ${q.intent}` : ""})`)
    .join("\n");
  const answer = await llm.generateJson(
    {
      model: opts.model,
      template: PERSONA_TEMPLATE,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Business:\n${JSON.stringify(business, null, 1)}\n\nSearches (number. search (monthly volume, intent)):\n${searches}`,
        },
      ],
      params: { temperature: 0, seed: 63 },
    },
    PersonaAnswer,
    rec,
  );
  return answer.personas;
}

const slug = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

const uniqueId = (name: string, taken: Set<string>, i: number) => {
  const base = slug(name) || `persona-${i + 1}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
};

/**
 * The checks on what the model wrote: evidence only from the shown searches, each search for one
 * persona, at least three; audience and offerings only from the lists; text that makes a claim
 * the business can't back is dropped (a need) or replaced by the audience or the name (who).
 */
export function checkPersonas(
  drafts: PersonaDraft[],
  pool: FilteredQuery[],
  context: ClientContext,
): Omit<Persona, "clusters">[] {
  const audiences = audiencesOf(context);
  const offerings = new Map<string, Offering>(
    (context.business?.offerings ?? []).map((o) => [o.id, o]),
  );
  const facts = claimFacts(
    context,
    pool.map((q) => q.normalized),
  );
  const clean = (t: string) => t.replace(/\s+/g, " ").trim();
  const ok = (t: string) => t.length > 0 && checkText(t, facts).length === 0;
  const used = new Set<number>();
  const ids = new Set<string>();
  const out: Omit<Persona, "clusters">[] = [];
  for (const d of drafts) {
    if (out.length >= PERSONAS.max) break;
    const name = clean(d.name);
    if (!name || !ok(name)) continue;
    const evidence = [...new Set(d.evidence)]
      .filter((i) => i < pool.length && !used.has(i))
      .map((i) => ({ i, q: pool[i] as FilteredQuery }));
    if (evidence.length < PERSONAS.minEvidence) continue;
    for (const e of evidence) used.add(e.i);
    const searches = evidence.map((e) => e.q).sort((a, b) => volumeOf(b) - volumeOf(a));
    const audience = d.audience
      ? audiences.find((a) => canonical(a) === canonical(d.audience as string))
      : undefined;
    const who = clean(d.who);
    out.push({
      id: uniqueId(name, ids, out.length),
      name,
      who: ok(who) ? who : (audience ?? name),
      ...(audience ? { audience } : {}),
      stage: personaStage(searches),
      needs: [...new Set(d.needs.map(clean).filter(ok))].slice(0, 4),
      evidence: searches.map((q) => q.normalized),
      volume: searches.reduce((s, q) => s + volumeOf(q), 0),
      offerings: [...new Set(d.offerings)].filter((id) => offerings.has(id)),
      source: "model",
    });
  }
  return out;
}

/** Without a model: each context audience whose own words show up in three or more searches. */
export function audiencePersonas(
  context: ClientContext,
  queries: FilteredQuery[],
): Omit<Persona, "clusters">[] {
  const language = context.market.language;
  const kept = queries.filter((q) => q.filter?.kept).sort((a, b) => volumeOf(b) - volumeOf(a));
  const used = new Set<string>();
  const ids = new Set<string>();
  const out: Omit<Persona, "clusters">[] = [];
  for (const audience of audiencesOf(context)) {
    if (out.length >= PERSONAS.max) break;
    const marks = new Set(audienceStems(audience, context));
    if (!marks.size) continue;
    const searches = kept.filter(
      (q) => !used.has(q.normalized) && stems(q.normalized, language).some((s) => marks.has(s)),
    );
    if (searches.length < PERSONAS.minEvidence) continue;
    for (const q of searches) used.add(q.normalized);
    const offerings = (context.business?.offerings ?? [])
      .filter((o) => o.audiences.some((a) => canonical(a) === canonical(audience)))
      .map((o) => o.id);
    out.push({
      id: uniqueId(audience, ids, out.length),
      name: audience,
      who: audience,
      audience,
      stage: personaStage(searches),
      needs: [],
      evidence: searches.slice(0, 20).map((q) => q.normalized),
      volume: searches.reduce((s, q) => s + volumeOf(q), 0),
      offerings,
      source: "audience",
    });
  }
  return out;
}

/**
 * Which page is mainly for whom: a page cluster goes to the persona with the most of its searches
 * in its evidence (x3) or with its marker words (words in two or more of its searches and in no
 * other persona's). A tie or no match leaves the page for everyone.
 */
export function assignClusters(
  personas: Omit<Persona, "clusters">[],
  clusters: Cluster[],
  context: ClientContext,
): Persona[] {
  const language = context.market.language;
  const common = commonStems(context);
  const counts = personas.map((p) => {
    const c = new Map<string, number>();
    for (const q of p.evidence)
      for (const s of new Set(stems(q, language)))
        if (!common.has(s)) c.set(s, (c.get(s) ?? 0) + 1);
    return c;
  });
  const markers = personas.map((p, i) => {
    const own = [...(counts[i] as Map<string, number>).entries()]
      .filter(([s, n]) => n >= 2 && counts.every((c, j) => j === i || !c.has(s)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, PERSONAS.markers)
      .map(([s]) => s);
    const fromAudience = p.audience ? audienceStems(p.audience, context) : [];
    return new Set([...own, ...fromAudience]);
  });
  const evidence = personas.map((p) => new Set(p.evidence.map((q) => canonical(q))));
  const out = personas.map((p) => ({ ...p, clusters: [] as string[] }));
  for (const c of clusters) {
    if (c.qdp !== "page") continue;
    const qs = c.queries.map((q) => canonical(q));
    const scores = personas.map(
      (_, i) =>
        3 * qs.filter((q) => evidence[i]?.has(q)).length +
        qs.filter((q) => stems(q, language).some((s) => markers[i]?.has(s))).length,
    );
    const best = Math.max(0, ...scores);
    if (best === 0 || scores.filter((s) => s === best).length > 1) continue;
    out[scores.indexOf(best)]?.clusters.push(c.id);
  }
  return out;
}
