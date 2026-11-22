import {
  BRIEF_VERSION,
  Brief,
  type BriefEvidence,
  type BriefHeading,
  type EvidenceSource,
  SectionForm,
} from "@mycel/schema";
import type { z } from "zod";
import type { JsonModel } from "../context/llm.ts";
import { checkText, claimFacts } from "../map/check.ts";
import { defineStep } from "../step.ts";
import {
  BRIEF_TEMPLATE,
  type BriefAnswer,
  BriefAnswer as BriefAnswerSchema,
  BriefInput,
  buildBriefMessages,
} from "./prompt.ts";
import { BRIEF } from "./rules.ts";
import { briefSearches } from "./sources.ts";

/**
 * The brief step (ADR 0020): one model call per page writes the message, the reader, the angle
 * and the outline around the data, then the checks below keep it to the facts. The model can
 * only point at evidence, questions and links it was shown; a text that claims something the
 * business can't back is dropped (a point) or flagged for the person (the other texts).
 */

/** 1: the first structured brief (brief prompt v1, file version 2). */
export const BRIEF_STEP_VERSION = "1";

const slug = (nodeId: string) => nodeId.toLowerCase().replace(/[^a-z0-9-]+/g, "-");

/** One step per page: its run folder is named after the page. */
export const briefStepName = (nodeId: string) => `brief-${slug(nodeId)}`;

/** Briefs live next to the map, one file per page: briefs/<node id>.json. */
export const BRIEFS_DIR = "briefs";
export const briefFileName = (nodeId: string) => `${slug(nodeId)}.json`;

const clean = (t: string) => t.replace(/\s+/g, " ").trim();
const sameSource = (a: EvidenceSource, b: EvidenceSource) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Numbers a text names that none of the given texts has: a figure the model made up. */
export function unbackedNumbers(text: string, backed: string): string[] {
  const have = new Set([...backed.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]));
  return [
    ...new Set([...text.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]).filter((n) => !have.has(n))),
  ];
}

export interface BriefCheck {
  problems(text: string): string[];
}

function briefCheck(input: BriefInput): BriefCheck {
  const searches = briefSearches(input.page);
  const facts = claimFacts(input.context, [...searches, ...input.questions.map((q) => q.question)]);
  const backed = [
    ...input.evidence.map((e) => e.fact),
    ...searches,
    ...input.questions.map((q) => q.question),
    ...input.results.map((r) => r.title),
    ...input.terms,
    input.context.site.name,
  ].join(" \n ");
  return {
    problems: (text) => [
      ...checkText(text, facts),
      ...unbackedNumbers(text, backed).map((n) => `number ${n} is in no evidence or search`),
    ],
  };
}

/** Word targets per heading, scaled so they add up to the page's target. */
function spreadWords(outline: { words: number }[], total: number): number[] {
  const sum = outline.reduce((n, h) => n + h.words, 0);
  const share = (w: number) => (sum > 0 ? w / sum : 1 / outline.length);
  return outline.map((h) => Math.max(10, Math.round((share(h.words) * total) / 10) * 10));
}

/** The outline as the schema wants it: one H1 first, H3s under an H2, known forms and facts. */
function shapeOutline(
  input: BriefInput,
  answer: BriefAnswer,
  check: BriefCheck,
  warnings: string[],
): BriefHeading[] {
  const known = new Set(input.evidence.map((e) => e.id));
  const out: BriefHeading[] = [];
  let dropped = 0;
  for (const h of answer.outline) {
    const heading = clean(h.heading);
    if (!heading) continue;
    const unknown = h.evidence.filter((id) => !known.has(id));
    if (unknown.length)
      warnings.push(`"${heading}" pointed at evidence that isn't there: ${unknown.join(", ")}`);
    const points: string[] = [];
    for (const p of h.points.map(clean).filter(Boolean)) {
      if (check.problems(p).length) dropped++;
      else if (points.length < BRIEF.maxPoints) points.push(p);
    }
    for (const [what, text] of [
      ["heading", heading],
      ["purpose", clean(h.purpose)],
    ] as const) {
      const problems = check.problems(text);
      if (problems.length) warnings.push(`check the ${what} "${text}": ${problems.join("; ")}`);
    }
    const form = SectionForm.safeParse(h.form);
    out.push({
      level: h.level,
      heading,
      purpose: clean(h.purpose) || heading,
      form: form.success ? form.data : "prose",
      points,
      evidence: [...new Set(h.evidence.filter((id) => known.has(id)))],
      words: h.words,
    });
  }
  if (dropped)
    warnings.push(`${dropped} outline point(s) dropped: they claimed what no evidence backs`);
  // One H1, first; the model's later H1s become H2s, an H3 before any H2 becomes one too.
  const firstH1 = out.findIndex((h) => h.level === "h1");
  if (firstH1 > 0) out.unshift(...out.splice(firstH1, 1));
  if (out[0]?.level !== "h1") {
    const name = input.page.name ?? input.page.mainQuery;
    out.unshift({
      level: "h1",
      heading: name,
      purpose: clean(answer.coreMessage) || name,
      form: "prose",
      points: [],
      evidence: [],
      words: 0,
    });
  }
  let h2 = false;
  for (const [i, h] of out.entries()) {
    if (i > 0 && h.level === "h1") h.level = "h2";
    if (h.level === "h3" && !h2) h.level = "h2";
    if (h.level === "h2") h2 = true;
  }
  return out;
}

/**
 * The brief from the model's answer and the data, after the checks. Not parsed here: the step
 * validates it, and asks the model again when it doesn't fit (an empty text, no outline).
 */
export function assembleBrief(
  input: BriefInput,
  answer: BriefAnswer,
  runId: string,
): z.input<typeof Brief> {
  const { context: ctx, page } = input;
  const check = briefCheck(input);
  const warnings: string[] = [];
  if (!ctx.business) warnings.push("no business profile: the brief has no facts to use");
  else if (!ctx.business.confirmed) warnings.push("the business profile is not confirmed yet");
  if (!input.results.length)
    warnings.push(`no results page for "${page.mainQuery}" in the research`);

  const required = (what: string, text: string) => {
    // An empty text fails the schema, so the step asks the model again (step contract).
    const t = clean(text);
    const problems = check.problems(t);
    if (problems.length) warnings.push(`check ${what}: ${problems.join("; ")}`);
    return t;
  };
  const coreMessage = required("the core message", answer.coreMessage);
  const reader = {
    searchesFor: required("what the reader searches for", answer.reader.searchesFor),
    feels: required("how the reader feels", answer.reader.feels),
    doesNext: required("what the reader does next", answer.reader.doesNext),
  };
  const difference = required("the difference", answer.difference);
  const action = required("the call to action", answer.cta);

  // An outline with nothing under the H1 fails the schema: the model is asked again.
  const shaped = shapeOutline(input, answer, check, warnings);
  const words = spreadWords(shaped, input.targets.words);
  const outline: BriefHeading[] = shaped.map((h, i) => ({ ...h, words: words[i] ?? 10 }));

  // Only the facts the outline uses; a person's check carries over when fact and source match.
  const used = new Set(outline.flatMap((h) => h.evidence));
  const evidence: BriefEvidence[] = input.evidence
    .filter((e) => used.has(e.id))
    .map((e) => {
      const before = input.previous.find(
        (p) => p.fact === e.fact && sameSource(p.source, e.source),
      );
      return { ...e, check: before?.check ?? { state: "unchecked" } };
    });

  const questions = [...new Set(answer.questions)]
    .filter((i) => i < input.questions.length)
    .slice(0, BRIEF.maxQuestions)
    .map((i) => input.questions[i] as BriefInput["questions"][number]);

  const anchors = new Map(answer.links.map((l) => [l.i, clean(l.anchor)]));
  const links = input.links.map((l, i) => {
    const a = anchors.get(i);
    return a && checkText(a, claimFacts(ctx, briefSearches(page))).length === 0
      ? { ...l, anchor: a }
      : l;
  });

  return {
    version: BRIEF_VERSION,
    site: ctx.site,
    market: ctx.market,
    page: {
      nodeId: page.id,
      name: page.name ?? page.mainQuery,
      mainQuery: page.mainQuery,
      queries: page.queries,
      url: page.existingPage?.url ?? page.proposedUrl,
      existingUrl: page.existingPage?.url ?? null,
      action: page.action,
      intent: page.intent.main,
      ...(page.persona ? { persona: page.persona } : {}),
    },
    research: input.research,
    createdAt: input.now,
    made: { runId, stepVersion: BRIEF_STEP_VERSION, model: input.model, prompt: BRIEF_TEMPLATE },
    coreMessage,
    reader,
    difference: { text: difference, against: input.results },
    evidence,
    outline,
    avoid: [...new Set(answer.avoid.map(clean).filter(Boolean))].slice(0, BRIEF.maxAvoid),
    questions,
    links,
    cta: { action, ...(ctx.business?.conversion ? { conversion: ctx.business.conversion } : {}) },
    targets: {
      words: input.targets.words,
      headings: outline.filter((h) => h.level !== "h1").length,
      keyword: input.targets.keyword,
      readingLevel: input.targets.readingLevel,
    },
    terms: input.terms,
    warnings,
  };
}

export function briefStep(llm: JsonModel, nodeId: string) {
  return defineStep({
    name: briefStepName(nodeId),
    version: BRIEF_STEP_VERSION,
    input: BriefInput,
    output: Brief,
    maxAttempts: 2,
    async run(input, ctx) {
      const answer = await llm.generateJson(
        {
          model: input.model,
          template: BRIEF_TEMPLATE,
          messages: buildBriefMessages(input),
          params: { temperature: 0.3, seed: 20 + ctx.attempt },
        },
        BriefAnswerSchema,
        ctx,
      );
      return assembleBrief(input, answer, ctx.runId);
    },
  });
}
