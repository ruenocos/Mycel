import { z } from "zod";

/**
 * The output contract of the CLI (ADR 0015): the one object `mycel <command> --json` prints on
 * stdout, on success and on failure. A caller (a script, or Claude driving a run) reads this
 * instead of the text for people.
 *
 * Fields are added, never renamed or removed. A reader ignores what it doesn't know.
 */

export const CliError = z.object({
  /** One of core's ERROR_CODES, e.g. "INPUT_MISSING". The exit code follows from it. */
  code: z.string().min(1),
  /** What went wrong, with the file, run or value it is about. */
  message: z.string(),
  /** What to do about it: a command to run or a setting to change. */
  fix: z.string().optional(),
  /** True when running the same command again can succeed. */
  transient: z.boolean(),
});
export type CliError = z.infer<typeof CliError>;

/** What to do after this command: a command to paste, a remark, or both. */
export const CliNextStep = z.object({
  command: z.string().optional(),
  note: z.string().optional(),
});
export type CliNextStep = z.infer<typeof CliNextStep>;

/** One step of the run, in numbers. Every call behind it is in the run's log (ADR 0009). */
export const CliStep = z.object({
  name: z.string(),
  status: z.enum(["running", "ok", "failed", "interrupted"]),
  durationMs: z.number().optional(),
  costUsd: z.number(),
  llmCalls: z.number().int(),
  apiCalls: z.number().int(),
  /** How many of the API calls were answered from the cache. */
  cachedApiCalls: z.number().int(),
  /** The step did not run: its output was taken from this earlier run (--resume). */
  reusedFrom: z.string().optional(),
});
export type CliStep = z.infer<typeof CliStep>;

export const CliOutput = z
  .object({
    status: z.enum(["ok", "failed"]),
    /** The command as typed after `mycel`, without arguments: "cluster", "eval filter". */
    command: z.string(),
    /** Version of the code that ran, with its git commit when there is one: "0.0.0+a07b883". */
    version: z.string(),
    /** The exit code of the process: 0 exactly when status is "ok". */
    exitCode: z.number().int().nonnegative(),
    /** Set when the command ran inside a run; `mycel logs <runId>` shows all of it. */
    runId: z.string().optional(),
    /** Files written, by what they are. Pointers: the data itself stays in the files. */
    outputs: z.record(z.string(), z.string()),
    /** The lines a person would read: `label      value`. */
    summary: z.array(z.string()),
    /** The same result in numbers, for the commands that have them. Never the dataset. */
    data: z.record(z.string(), z.unknown()).optional(),
    /** What the run cost. 0 when nothing ran. */
    costUsd: z.number().nonnegative(),
    steps: z.array(CliStep),
    /** Things that did not stop the command but colour its result ("trial run", "no pages"). */
    warnings: z.array(z.string()),
    /** Empty on failure: the error's fix says what to do. */
    next: z.array(CliNextStep),
    /** After a failure: the command that continues without redoing what finished. */
    retry: z.string().optional(),
    error: CliError.optional(),
  })
  .refine((o) => (o.status === "failed") === (o.error !== undefined), {
    message: "error is set exactly when status is failed",
  })
  .refine((o) => (o.status === "ok") === (o.exitCode === 0), {
    message: "exitCode is 0 exactly when status is ok",
  });
export type CliOutput = z.infer<typeof CliOutput>;
