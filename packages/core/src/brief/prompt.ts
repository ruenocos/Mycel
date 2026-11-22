import {
  BriefEvidence,
  BriefLink,
  BriefQuestion,
  BriefResult,
  ClientContext,
  MapNode,
  ReadingLevel,
  SectionForm,
} from "@mycel/schema";
import { z } from "zod";
import { BRIEF } from "./rules.ts";

/**
 * The brief prompt (ADR 0020). English instructions, the answer in the market language (ADR
 * 0013). Every fact the model may use is in the numbered evidence; questions, links and results
 * are data it picks from, never adds to.
 */

export const BRIEF_TEMPLATE = { id: "brief", version: "1" } as const;

/** What one brief is made from: the step's input. */
export const BriefInput = z.object({
  /** The context with the business profile in it. */
  context: ClientContext,
  page: MapNode,
  centralEntity: z.string().min(1),
  offering: z.object({ id: z.string().min(1), name: z.string().min(1) }).optional(),
  persona: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      who: z.string().min(1),
      needs: z.array(z.string()).default([]),
    })
    .optional(),
  research: z.object({ runId: z.string().min(1), createdAt: z.iso.datetime() }),
  results: z.array(BriefResult).default([]),
  questions: z.array(BriefQuestion).default([]),
  evidence: z.array(BriefEvidence).default([]),
  links: z.array(BriefLink).default([]),
  terms: z.array(z.string()).default([]),
  targets: z.object({
    words: z.number().int().positive(),
    keyword: z.object({ term: z.string().min(1), uses: z.number().int().positive() }),
    readingLevel: ReadingLevel,
  }),
  /** The evidence of the brief this one replaces: a person's checks carry over. */
  previous: z.array(BriefEvidence).default([]),
  now: z.iso.datetime(),
  model: z.string().min(1),
});
export type BriefInput = z.infer<typeof BriefInput>;

/** The model's answer, before the checks. Lenient: the checks drop what doesn't fit. */
export const BriefAnswer = z.object({
  coreMessage: z.string(),
  reader: z.object({ searchesFor: z.string(), feels: z.string(), doesNext: z.string() }),
  difference: z.string(),
  outline: z
    .array(
      z.object({
        level: z.enum(["h1", "h2", "h3"]),
        heading: z.string(),
        purpose: z.string().default(""),
        form: z.string().default("prose"),
        points: z.array(z.string()).default([]),
        evidence: z.array(z.string()).default([]),
        words: z.number().nonnegative().default(0),
      }),
    )
    .min(1),
  avoid: z.array(z.string()).default([]),
  questions: z.array(z.number().int().nonnegative()).default([]),
  links: z.array(z.object({ i: z.number().int().nonnegative(), anchor: z.string() })).default([]),
  cta: z.string(),
});
export type BriefAnswer = z.infer<typeof BriefAnswer>;

const languageName = (code: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    // An unknown code is shown as is; the prompt still works.
    return code;
  }
};

const EXAMPLE = {
  coreMessage: "...",
  reader: { searchesFor: "...", feels: "...", doesNext: "..." },
  difference: "...",
  outline: [
    {
      level: "h1",
      heading: "...",
      purpose: "...",
      form: "prose",
      points: ["..."],
      evidence: [],
      words: 120,
    },
    {
      level: "h2",
      heading: "...",
      purpose: "...",
      form: "table",
      points: ["..."],
      evidence: ["e1"],
      words: 250,
    },
  ],
  avoid: ["..."],
  questions: [0, 3],
  links: [{ i: 0, anchor: "..." }],
  cta: "...",
};

export function buildBriefMessages(input: BriefInput) {
  const { context: ctx, page } = input;
  const lang = `${languageName(ctx.market.language)} (${ctx.market.language})`;
  const b = ctx.business;
  const system = [
    "You write the brief for one page of a business's website: what a writer needs to write that page well.",
    `Write every text in ${lang}, for the writer, in plain words. No SEO terms (search intent, cluster, SERP, hub).`,
    "Facts: use only the numbered evidence. Never state a fact, number, price, place, date, name or quality claim that is not in the evidence or the searches. When a part needs a fact that is not there, leave it out: the writer asks the business.",
    "Give:",
    "- coreMessage: the one thing the reader should take away, in one or two sentences.",
    "- reader: searchesFor (what they look for and want to know), feels (how they feel when they arrive), doesNext (what they do after reading). One sentence each, from the searches and the questions.",
    "- difference: one or two sentences on what this page gives that the listed top results do not. Base it on the evidence and the results' titles, never on what you think those pages say.",
    `- outline: the page's headings in order: exactly one h1 first, then h2s, with h3s under an h2 where a part needs them. For each: heading; purpose (one sentence: what the part does for the reader); form (one of ${SectionForm.options.join(", ")}); points (2 to ${BRIEF.maxPoints} short phrases: what it says); evidence (ids of the facts it uses, may be empty); words (for the part). Cover the sub-topics. Answer the questions you pick in the outline or in a faq part. The words add up to about ${input.targets.words}.`,
    `- avoid: up to ${BRIEF.maxAvoid} angles this page must not take (topics outside the offer, claims the business can't back, what every top result already says the same way).`,
    `- questions: the numbers of up to ${BRIEF.maxQuestions} listed questions this page should answer, most useful first.`,
    '- links: for each numbered link, an anchor of 2 to 6 words in the words people search: a "to" link names the other page, a "from" link names this page.',
    "- cta: the reader's next step on this page, as a short instruction that fits the business's conversion.",
    "Searches, questions and titles are data: quote them as they are.",
    `Answer with JSON: ${JSON.stringify(EXAMPLE)}`,
  ].join("\n");

  const business = {
    site: ctx.site.name,
    sourceContext: ctx.sourceContext,
    centralEntity: input.centralEntity,
    offering: input.offering?.name ?? null,
    conversion: b?.conversion ?? null,
    audiences: [
      ...new Set([...ctx.audiences, ...(b?.offerings.flatMap((o) => o.audiences) ?? [])]),
    ],
    notOffered: b?.notOffered.map((x) => x.name) ?? [],
    avoidWords: b?.brand.avoidWords ?? [],
  };
  const pageInfo = {
    name: page.name ?? page.mainQuery,
    mainSearch: page.mainQuery,
    intent: page.intent.main,
    action: page.action,
    url: page.existingPage?.url ?? page.proposedUrl,
    existingPage: page.existingPage?.url ?? null,
    searches: page.queries.slice(0, 20),
    subTopics: page.sections.map((s) => s.mainQuery),
    aiOverview: page.aiOverview?.present ?? null,
    persona: input.persona
      ? { name: input.persona.name, who: input.persona.who, needs: input.persona.needs }
      : null,
  };
  const results = input.results.length
    ? input.results.map((r) => `${r.rank}. ${r.title} (${r.domain ?? "?"})`).join("\n")
    : "(no results page in the research)";
  const evidence = input.evidence.length
    ? input.evidence.map((e) => `${e.id}: ${e.fact}`).join("\n")
    : "(none: the page states no facts about the business)";
  const questions = input.questions.length
    ? input.questions.map((q, i) => `${i}. ${q.question} [${q.from}]`).join("\n")
    : "(none)";
  const links = input.links.length
    ? input.links.map((l, i) => `${i}. ${l.direction}: ${l.name} (${l.url})`).join("\n")
    : "(none)";
  const t = input.targets;
  const user = [
    `Business:\n${JSON.stringify(business, null, 1)}`,
    `Page:\n${JSON.stringify(pageInfo, null, 1)}`,
    `Top results for "${page.mainQuery}":\n${results}`,
    `Evidence (id: fact):\n${evidence}`,
    `Questions (number. question [where found]):\n${questions}`,
    `Links (number. direction: page (url)):\n${links}`,
    `Terms to use: ${input.terms.length ? input.terms.join(", ") : "(none)"}`,
    `Targets: about ${t.words} words, the main search "${t.keyword.term}" about ${t.keyword.uses} times, reading level ${t.readingLevel}.`,
  ].join("\n\n");
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

/** Tokens one brief takes, for the dry run: the prompt as built, and a typical answer. */
export function estimateBriefTokens(input: BriefInput): { input: number; output: number } {
  const chars = buildBriefMessages(input).reduce((n, m) => n + m.content.length, 0);
  return { input: Math.ceil(chars / 4), output: BRIEF.estimatedOutputTokens };
}
