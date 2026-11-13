import {
  ClientContext,
  type ContextAnswer,
  ContextEvidence,
  Market,
  type SitePages,
} from "@mycel/schema";
import { z } from "zod";
import { languageName } from "../evals/writing.ts";
import { defineStep } from "../step.ts";
import type { JsonModel } from "./llm.ts";

/**
 * Koray steps 1-6 (issue #15): Mycel reads the site and its search data, proposes plain answers
 * to the nine client questions, and a human confirms them. Prompt in English, answers in the
 * market language (ADR 0013).
 */

export const CONTEXT_TEMPLATE = { id: "context-propose", version: "2" } as const;

/** The nine SOP questions, asked the way a business owner talks (doc 02). */
export const CLIENT_QUESTIONS = [
  { id: "offerings", en: "What do you sell or offer?", nl: "Wat verkoop of bied je aan?" },
  {
    id: "main-topic",
    en: "What is the website mainly about?",
    nl: "Waar gaat je website vooral over?",
  },
  {
    id: "site-goal",
    en: "What is the main goal of the site?",
    nl: "Wat moet de website vooral opleveren?",
  },
  {
    id: "monetization",
    en: "How do you make money from visitors?",
    nl: "Waar verdien je je geld mee?",
  },
  { id: "audience", en: "Who are your customers?", nl: "Wie zijn je klanten?" },
  {
    id: "audience-goal",
    en: "What do those customers come to the site to do?",
    nl: "Wat komen die klanten op je site doen?",
  },
  {
    id: "problems",
    en: "What problems do customers have before they look for a solution?",
    nl: "Met welk probleem zitten klanten voordat ze gaan zoeken?",
  },
  {
    id: "competitors",
    en: "Who are your main competitors online?",
    nl: "Wie zijn je belangrijkste concurrenten online?",
  },
  {
    id: "differentiator",
    en: "What makes you different from them?",
    nl: "Wat maakt jou anders dan zij?",
  },
] as const;
export type ClientQuestionId = (typeof CLIENT_QUESTIONS)[number]["id"];

/** The question in the market language when we have it, otherwise English. */
export function questionText(id: string, language: string): string {
  const q = CLIENT_QUESTIONS.find((x) => x.id === id);
  if (!q) return id;
  return (q as Record<string, string>)[language] ?? q.en;
}

export interface EvidenceExtras {
  gscQueries?: ContextEvidence["gscQueries"];
  rankedKeywords?: ContextEvidence["rankedKeywords"];
  competitorDomains?: ContextEvidence["competitorDomains"];
  siteName?: string;
}

/** Pages whose body text says most about the business: home first, then non-blog pages. */
const TEXT_KINDS = [
  "home",
  "about",
  "service",
  "pricing",
  "category",
  "product",
  "location",
  "contact",
  "other",
];

/**
 * Bounded, deterministic evidence: every page by title, body text for at most `textPages`
 * business pages, and the top search rows. Same input, same evidence, same prompt hash.
 */
export function buildEvidence(
  site: SitePages,
  siteUrl: string,
  extras: EvidenceExtras = {},
  limits: { textPages?: number; textChars?: number; rows?: number; maxPages?: number } = {},
): ContextEvidence {
  const textPages = limits.textPages ?? 12;
  const textChars = limits.textChars ?? 500;
  const rows = limits.rows ?? 50;
  const rank = (kind: string) => {
    const i = TEXT_KINDS.indexOf(kind);
    return i === -1 ? TEXT_KINDS.length : i;
  };
  const withText = new Set(
    [...site.pages]
      .filter((p) => p.kind !== "blog" && p.kind !== "guide")
      .sort(
        (a, b) =>
          rank(a.kind) - rank(b.kind) || a.url.length - b.url.length || a.url.localeCompare(b.url),
      )
      .slice(0, textPages)
      .map((p) => p.url),
  );
  const pages = [...site.pages]
    .sort((a, b) => a.url.localeCompare(b.url))
    .slice(0, limits.maxPages ?? 150)
    .map((p) => ({
      id: `page:${p.url}`,
      url: p.url,
      kind: p.kind,
      title: p.title,
      h1: p.h1,
      ...(p.metaDescription ? { metaDescription: p.metaDescription } : {}),
      ...(withText.has(p.url) ? { text: p.text.slice(0, textChars) } : {}),
    }));
  const home = site.pages.find((p) => p.kind === "home");
  const name =
    extras.siteName ??
    home?.title
      .split(/\s[|–-]\s/)
      .pop()
      ?.trim() ??
    new URL(siteUrl).hostname;
  return ContextEvidence.parse({
    site: { url: siteUrl, name: name || new URL(siteUrl).hostname },
    pages,
    gscQueries: (extras.gscQueries ?? []).slice(0, rows),
    rankedKeywords: (extras.rankedKeywords ?? []).slice(0, rows),
    competitorDomains: (extras.competitorDomains ?? []).slice(0, 15),
  });
}

/** What the model returns. Mapped onto ClientContext by code, so the model can't skip fields. */
export const ContextProposal = z.object({
  siteName: z.string().min(1),
  sourceContext: z.string().min(1),
  centralEntities: z
    .array(
      z.object({
        name: z.string().min(1),
        disambiguation: z.string().min(1),
        notThis: z.array(z.string().min(1)).default([]),
      }),
    )
    .min(1)
    .max(3),
  centralSearchIntent: z.string().min(1),
  audiences: z.array(z.string().min(1)).min(1),
  offerings: z.array(z.string().min(1)).min(1),
  competitors: z.array(z.string().min(1)).default([]),
  answers: z.array(
    z.object({
      id: z.string().min(1),
      answer: z.string().min(1),
      evidence: z.array(z.string()).default([]),
    }),
  ),
});
export type ContextProposal = z.infer<typeof ContextProposal>;

function evidenceText(ev: ContextEvidence): string {
  const parts: string[] = [];
  parts.push(`SITE: ${ev.site.name} (${ev.site.url})`);
  parts.push("PAGES (id | kind | title | h1 | meta, then body text for some pages):");
  for (const p of ev.pages) {
    parts.push(
      `- ${p.id} | ${p.kind} | ${p.title} | ${p.h1}${p.metaDescription ? ` | ${p.metaDescription}` : ""}`,
    );
    if (p.text) parts.push(`  text: ${p.text.replace(/\s+/g, " ")}`);
  }
  if (ev.gscQueries.length) {
    parts.push("GSC QUERIES (evidence id: gsc) query | clicks | impressions:");
    for (const q of ev.gscQueries) parts.push(`- ${q.query} | ${q.clicks} | ${q.impressions}`);
  }
  if (ev.rankedKeywords.length) {
    parts.push("RANKED KEYWORDS (evidence id: ranked) keyword | position | monthly volume | url:");
    for (const k of ev.rankedKeywords) {
      parts.push(`- ${k.keyword} | ${k.position ?? "?"} | ${k.volume ?? "?"} | ${k.url ?? ""}`);
    }
  }
  if (ev.competitorDomains.length) {
    parts.push("COMPETING DOMAINS (evidence id: competitors) domain | shared keywords:");
    for (const c of ev.competitorDomains) parts.push(`- ${c.domain} | ${c.sharedKeywords ?? "?"}`);
  } else {
    parts.push("COMPETING DOMAINS: no data. Do not name competitors you were not given.");
  }
  return parts.join("\n");
}

export function buildContextMessages(
  ev: ContextEvidence,
  market: Market,
): { role: "system" | "user"; content: string }[] {
  const lang = languageName(market.language);
  const where = `${market.country}${market.city ? `, ${market.city}` : ""}`;
  const system = [
    "You are a senior SEO strategist preparing a topical map with Koray Tugberk Gubur's method.",
    "Before any map, you answer nine questions about the business, using only the evidence given.",
    "Never invent facts, prices, numbers or competitor names. If the evidence does not show something, say so plainly in the answer.",
    "A central entity is what the site is mainly about, with its meaning pinned down (e.g. ERP as software, not a place name).",
    "notThis lists other meanings of the same words (homonyms and look-alikes, e.g. Erp the village). Never put competitors, alternatives or related products in notThis: searches comparing them are relevant.",
    "The source context is how the site earns money from search traffic. The central search intent combines source context and central entity as verbs plus nouns (e.g. 'choose, buy and care for houseplants').",
    `Write every value in ${lang} (${market.language}), in plain words a business owner understands. Do not mix in English words unless they are names or terms the evidence itself uses. Keep keywords, product names and quoted titles exactly as they appear in the evidence.`,
    "Return only JSON.",
  ].join("\n");
  const questions = CLIENT_QUESTIONS.map((q) => `- ${q.id}: ${q.en}`).join("\n");
  const user = [
    `Market: ${where}, language ${market.language}.`,
    "",
    "Answer each question below in 1-3 sentences, and cite the evidence ids you used (page ids like page:/about/, or gsc, ranked, competitors).",
    questions,
    "",
    "Return JSON with exactly these keys:",
    '{"siteName": string, "sourceContext": string, "centralEntities": [{"name": string, "disambiguation": string, "notThis": [string]}], "centralSearchIntent": string, "audiences": [string], "offerings": [string], "competitors": [domain], "answers": [{"id": one of the question ids, "answer": string, "evidence": [evidence id]}]}',
    "Use 1 central entity unless the site clearly serves separate topics (max 3). Competitors must come from COMPETING DOMAINS; leave the list empty when there are none.",
    "",
    "EVIDENCE",
    evidenceText(ev),
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * What JSON validation can't catch. Missing answers are a hard problem (the step asks again);
 * unknown evidence ids and competitors not in the data are removed, and each removal is logged.
 */
export function checkProposal(
  p: ContextProposal,
  ev: ContextEvidence,
): { proposal: ContextProposal; missing: string[]; removed: string[] } {
  const ids = new Set(p.answers.map((a) => a.id));
  const missing = CLIENT_QUESTIONS.filter((q) => !ids.has(q.id)).map((q) => q.id);
  const removed: string[] = [];
  const known = new Set<string>([...ev.pages.map((x) => x.id), "gsc", "ranked", "competitors"]);
  const answers = p.answers.map((a) => ({
    ...a,
    evidence: a.evidence.filter((e) => {
      if (known.has(e)) return true;
      removed.push(`answer "${a.id}" cited unknown evidence "${e}"`);
      return false;
    }),
  }));
  const given = new Set(ev.competitorDomains.map((c) => c.domain));
  const competitors = p.competitors.filter((c) => {
    if (given.has(c)) return true;
    removed.push(`competitor "${c}" is not in the evidence`);
    return false;
  });
  return { proposal: { ...p, answers, competitors }, missing, removed };
}

/** Maps the proposal onto ClientContext. Not parsed here: the step contract validates it. */
export function toClientContext(
  p: ContextProposal,
  ev: ContextEvidence,
  market: Market,
): z.input<typeof ClientContext> {
  const byId = new Map(p.answers.map((a) => [a.id, a]));
  const answers: ContextAnswer[] = CLIENT_QUESTIONS.map((q) => {
    const a = byId.get(q.id);
    return {
      id: q.id,
      question: questionText(q.id, market.language),
      answer: a?.answer ?? "",
      status: "proposed" as const,
      evidence: a?.evidence ?? [],
    };
  });
  return {
    site: { url: ev.site.url, name: p.siteName },
    market,
    sourceContext: p.sourceContext,
    centralEntities: p.centralEntities,
    centralSearchIntent: p.centralSearchIntent,
    audiences: p.audiences,
    offerings: p.offerings,
    competitors: p.competitors,
    answers,
  };
}

export const ContextProposeInput = z.object({
  evidence: ContextEvidence,
  market: Market,
  model: z.string().min(1),
});

/** The step (step contract): evidence in, a proposed ClientContext out. */
export function contextProposeStep(llm: JsonModel) {
  return defineStep({
    name: "context-propose",
    version: CONTEXT_TEMPLATE.version,
    input: ContextProposeInput,
    output: ClientContext,
    maxAttempts: 2,
    async run(input, ctx) {
      const tries = 2;
      let last: ReturnType<typeof checkProposal> | undefined;
      for (let i = 1; i <= tries; i++) {
        const raw = await llm.generateJson(
          {
            model: input.model,
            template: CONTEXT_TEMPLATE,
            // A new seed per try, so asking again can give a different answer.
            params: { temperature: 0.2, seed: 6 + i + (ctx.attempt - 1) * tries },
            messages: buildContextMessages(input.evidence, input.market),
          },
          ContextProposal,
          ctx,
        );
        last = checkProposal(raw, input.evidence);
        if (last.removed.length)
          ctx.log.warn("context proposal cleaned", { removed: last.removed });
        if (!last.missing.length) break;
        ctx.log.warn("context proposal is missing answers", {
          missing: last.missing,
          try: i,
          tries,
        });
      }
      // Still missing after all tries: the empty answers fail output validation and the run stops.
      return toClientContext(
        (last as ReturnType<typeof checkProposal>).proposal,
        input.evidence,
        input.market,
      );
    },
  });
}
