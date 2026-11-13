import { z } from "zod";

/** Dutch writing test (issue #12): which model writes Mycel's Dutch text. */

export const WritingTaskKind = z.enum([
  "title",
  "meta",
  "brief",
  "article",
  "rewrite-b1",
  "factual",
]);
export type WritingTaskKind = z.infer<typeof WritingTaskKind>;

export const WritingSource = z.object({
  id: z.string().min(1),
  url: z.url(),
  text: z.string().min(1),
});
export type WritingSource = z.infer<typeof WritingSource>;

export const WritingTask = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  kind: WritingTaskKind,
  /** What to write, in the market language. */
  instruction: z.string().min(1),
  /** Facts are supplied, never taken from the model's memory (CLAUDE.md). */
  sources: z.array(WritingSource).min(1),
  limits: z
    .object({
      maxChars: z.number().int().positive().optional(),
      minWords: z.number().int().positive().optional(),
      maxWords: z.number().int().positive().optional(),
    })
    .default({}),
});
export type WritingTask = z.infer<typeof WritingTask>;

export const WritingTestSet = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    language: z.string().regex(/^[a-z]{2}$/),
    /** House style of the site the text is for. */
    brand: z.string().min(1),
    tasks: z.array(WritingTask).min(1),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    for (const [i, t] of s.tasks.entries()) {
      if (seen.has(t.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate task id ${t.id}`, path: ["tasks", i] });
      }
      seen.add(t.id);
    }
  });
export type WritingTestSet = z.infer<typeof WritingTestSet>;

/** One model's answer to one task, with the exact model version (ADR 0009). */
export const WritingOutput = z.object({
  taskId: z.string().min(1),
  model: z.string().min(1),
  modelDigest: z.string().optional(),
  text: z.string(),
  callId: z.string().optional(),
  error: z.string().optional(),
});
export type WritingOutput = z.infer<typeof WritingOutput>;

/** Blind label (A, B, C...) to model, per task. Kept apart from the sheet the scorer sees. */
export const WritingKey = z.object({
  runId: z.string().min(1),
  models: z.array(z.object({ model: z.string(), digest: z.string().optional() })),
  tasks: z.record(z.string(), z.record(z.string(), z.string())),
});
export type WritingKey = z.infer<typeof WritingKey>;

/** 1-5 per criterion, plus a flag for any made-up fact. */
export const WritingScore = z.object({
  taskId: z.string().min(1),
  label: z.string().min(1),
  natural: z.number().int().min(1).max(5),
  correct: z.number().int().min(1).max(5),
  tone: z.number().int().min(1).max(5),
  inventedFact: z.boolean(),
});
export type WritingScore = z.infer<typeof WritingScore>;
