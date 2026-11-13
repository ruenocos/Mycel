import { createHash } from "node:crypto";
import type {
  WritingKey,
  WritingOutput,
  WritingScore,
  WritingTask,
  WritingTestSet,
} from "@mycel/schema";

/**
 * Dutch writing test (issue #12): prompts, a cheap deterministic text check, a blind score
 * sheet and the decision rule from the plan (doc 12 §5). The CLI wires in the LLM client.
 */

export const WRITING_TEMPLATE = { id: "writing-test", version: "1" } as const;

const KIND_HINT: Record<WritingTask["kind"], string> = {
  title: "Geef alleen de titel, zonder aanhalingstekens of uitleg.",
  meta: "Geef alleen de meta description, zonder aanhalingstekens of uitleg.",
  brief: "Geef de brief als platte tekst met korte kopjes.",
  article: "Geef het artikel in Markdown, met H2-kopjes en zonder H1.",
  "rewrite-b1": "Geef alleen de herschreven tekst.",
  factual: "Geef een kort antwoord en noem achter elke bewering de bron-id tussen haken, bv. [s1].",
};

export function buildWritingMessages(
  set: WritingTestSet,
  task: WritingTask,
): { role: "system" | "user"; content: string }[] {
  const limits: string[] = [];
  if (task.limits.maxChars) limits.push(`maximaal ${task.limits.maxChars} tekens`);
  if (task.limits.minWords) limits.push(`minimaal ${task.limits.minWords} woorden`);
  if (task.limits.maxWords) limits.push(`maximaal ${task.limits.maxWords} woorden`);
  const system = [
    "Je bent een ervaren Nederlandse webredacteur.",
    `Huisstijl: ${set.brand}`,
    "Gebruik alleen feiten uit de meegegeven bronnen. Staat iets er niet in, verzin het dan niet.",
    "Schrijf natuurlijk Nederlands: actief, concreet, geen opvulzinnen, geen Engelse leenwoorden waar een gewoon Nederlands woord bestaat.",
  ].join("\n");
  const sources = task.sources.map((s) => `[${s.id}] ${s.url}\n${s.text}`).join("\n\n");
  const head = [task.instruction];
  if (limits.length) head.push(`Lengte: ${limits.join(", ")}.`);
  head.push(KIND_HINT[task.kind]);
  const user = `${head.join("\n")}\n\nBronnen:\n${sources}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

const HEDGES = [
  "mogelijk",
  "misschien",
  "eventueel",
  "wellicht",
  "enigszins",
  "in principe",
  "over het algemeen",
  "in zekere zin",
  "vrij veel",
];
/** Phrases that read as machine-written Dutch. A starting list; the Schrijfcheck (phase 3) replaces it. */
const AI_PATTERNS = [
  "in de huidige",
  "in het huidige",
  "het is belangrijk om",
  "het is essentieel",
  "cruciaal",
  "naadloos",
  "duik",
  "ontdek",
  "kortom",
  "in een wereld waar",
  "speelt een belangrijke rol",
  "niet alleen",
  "game changer",
  "next level",
];

const count = (text: string, phrase: string) =>
  text.toLowerCase().split(new RegExp(`\\b${phrase}`, "u")).length - 1;

export interface AutoCheck {
  chars: number;
  words: number;
  avgSentenceWords: number;
  hedges: number;
  aiPatterns: string[];
  issues: string[];
}

export function autoCheck(task: WritingTask, text: string): AutoCheck {
  const clean = text.trim();
  const words = clean.split(/\s+/).filter(Boolean).length;
  const sentences = clean.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0).length || 1;
  const hedges = HEDGES.reduce((n, h) => n + count(clean, h), 0);
  const aiPatterns = AI_PATTERNS.filter((p) => count(clean, p) > 0);
  const issues: string[] = [];
  const { maxChars, minWords, maxWords } = task.limits;
  if (clean.length === 0) issues.push("empty");
  if (maxChars && clean.length > maxChars)
    issues.push(`too long: ${clean.length}/${maxChars} chars`);
  if (minWords && words < minWords) issues.push(`too short: ${words}/${minWords} words`);
  if (maxWords && words > maxWords) issues.push(`too long: ${words}/${maxWords} words`);
  if (task.kind === "factual") {
    const ids = new Set(task.sources.map((s) => s.id));
    const cited = [...clean.matchAll(/\[([a-z0-9-]+)\]/g)].map((m) => m[1] ?? "");
    if (cited.length === 0) issues.push("no source cited");
    const unknown = cited.filter((c) => !ids.has(c));
    if (unknown.length) issues.push(`unknown source ids: ${[...new Set(unknown)].join(", ")}`);
  }
  return {
    chars: clean.length,
    words,
    avgSentenceWords: Math.round((words / sentences) * 10) / 10,
    hedges,
    aiPatterns,
    issues,
  };
}

/** Deterministic shuffle per task, so the same run always gives the same sheet. */
function shuffled<T>(items: T[], seed: string): T[] {
  return items
    .map((item, i) => ({
      item,
      k: createHash("sha256").update(`${seed}:${i}`).digest("hex"),
    }))
    .sort((a, b) => a.k.localeCompare(b.k))
    .map((x) => x.item);
}

export interface BlindSheet {
  markdown: string;
  csv: string;
  key: WritingKey;
}

/** The score sheet for the human: per task, the answers under labels A, B, C in random order. */
export function blindSheet(
  set: WritingTestSet,
  outputs: WritingOutput[],
  runId: string,
  models: { model: string; digest?: string }[],
): BlindSheet {
  const labels = "ABCDEFGH".split("");
  const key: WritingKey = { runId, models, tasks: {} };
  const md: string[] = [
    `# ${set.name}: blind score sheet`,
    "",
    `Run \`${runId}\`. Score each answer 1-5 on natural Dutch, correctness and brand tone in`,
    "`scores.csv`, and put `y` in `invented` when an answer states something the sources don't",
    "say. Don't open `key.json` until you're done.",
    "",
  ];
  const csv = ["taskId,label,natural,correct,tone,invented"];
  for (const task of set.tasks) {
    const order = shuffled(
      models.map((m) => m.model),
      `${runId}:${task.id}`,
    );
    const mapping: Record<string, string> = {};
    md.push(`## ${task.id} (${task.kind})`, "", `> ${task.instruction}`, "");
    order.forEach((model, i) => {
      const label = labels[i] ?? String(i);
      mapping[label] = model;
      const out = outputs.find((o) => o.taskId === task.id && o.model === model);
      const text = out?.error ? `_(no answer: ${out.error})_` : (out?.text.trim() ?? "_(missing)_");
      md.push(`### ${label}`, "", text, "");
      csv.push(`${task.id},${label},,,,`);
    });
    key.tasks[task.id] = mapping;
  }
  return { markdown: md.join("\n"), csv: `${csv.join("\n")}\n`, key };
}

export function parseScores(csv: string): WritingScore[] {
  const rows = csv.trim().split(/\r?\n/).slice(1);
  return rows.map((line, i) => {
    const [taskId, label, natural, correct, tone, invented] = line
      .split(/[,;]/)
      .map((c) => c.trim());
    const n = (v: string | undefined, name: string) => {
      const x = Number(v);
      if (!Number.isInteger(x) || x < 1 || x > 5) {
        throw new Error(`scores.csv line ${i + 2}: ${name} must be 1-5, got "${v ?? ""}"`);
      }
      return x;
    };
    return {
      taskId: taskId ?? "",
      label: label ?? "",
      natural: n(natural, "natural"),
      correct: n(correct, "correct"),
      tone: n(tone, "tone"),
      inventedFact: /^(y|yes|j|ja|1|true)$/i.test(invented ?? ""),
    };
  });
}

export interface ModelResult {
  model: string;
  digest?: string;
  natural: number;
  correct: number;
  tone: number;
  overall: number;
  inventedFacts: number;
  byKind: Record<string, number>;
}

export interface WritingVerdict {
  results: ModelResult[];
  best: string;
  candidate: string;
  /** Doc 12 §5: the candidate writes if it is within 0.5 of the best and invents nothing. */
  candidateWrites: boolean;
  reason: string;
}

const avg = (xs: number[]) =>
  xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0;

export function verdict(
  set: WritingTestSet,
  key: WritingKey,
  scores: WritingScore[],
  candidate: string,
): WritingVerdict {
  const kindOf = new Map(set.tasks.map((t) => [t.id, t.kind]));
  const results: ModelResult[] = key.models.map(({ model, digest }) => {
    const mine = scores.filter((s) => key.tasks[s.taskId]?.[s.label] === model);
    const byKind: Record<string, number> = {};
    for (const kind of new Set(mine.map((s) => kindOf.get(s.taskId) ?? "?"))) {
      byKind[kind] = avg(
        mine
          .filter((s) => kindOf.get(s.taskId) === kind)
          .map((s) => (s.natural + s.correct + s.tone) / 3),
      );
    }
    return {
      model,
      ...(digest ? { digest } : {}),
      natural: avg(mine.map((s) => s.natural)),
      correct: avg(mine.map((s) => s.correct)),
      tone: avg(mine.map((s) => s.tone)),
      overall: avg(mine.map((s) => (s.natural + s.correct + s.tone) / 3)),
      inventedFacts: mine.filter((s) => s.inventedFact).length,
      byKind,
    };
  });
  results.sort((a, b) => b.overall - a.overall);
  const best = results[0];
  const cand = results.find((r) => r.model === candidate);
  if (!best || !cand) throw new Error(`no scores for ${candidate}`);
  const gap = Math.round((best.overall - cand.overall) * 100) / 100;
  const close = gap <= 0.5;
  const clean = cand.inventedFacts === 0;
  const candidateWrites = close && clean;
  const reason = candidateWrites
    ? `${candidate} is ${gap} behind the best and invented no facts: it writes.`
    : [
        close ? "" : `${candidate} is ${gap} behind ${best.model} (limit 0.5)`,
        clean ? "" : `${candidate} invented facts in ${cand.inventedFacts} answer(s)`,
      ]
        .filter(Boolean)
        .join("; ")
        .concat(": pick a model per task.");
  return { results, best: best.model, candidate, candidateWrites, reason };
}
