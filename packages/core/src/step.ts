import { closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RunStore, StepContext } from "./log/run-store.ts";

/**
 * The step contract (CLAUDE.md): typed input, run(), validated output.
 * Invalid output is retried up to maxAttempts, then the run stops. Never passed on silently.
 */
export interface StepDefinition<I extends z.ZodType, O extends z.ZodType> {
  name: string;
  /** Bump when the step's logic or prompt changes, so saved outputs from older versions aren't reused. */
  version: string;
  input: I;
  output: O;
  /** Attempts when output fails validation (LLM steps). Default 1: deterministic steps don't retry. */
  maxAttempts?: number;
  run(input: z.output<I>, ctx: StepContext & { attempt: number }): Promise<z.input<O>>;
}

export function defineStep<I extends z.ZodType, O extends z.ZodType>(
  def: StepDefinition<I, O>,
): StepDefinition<I, O> {
  return def;
}

export class StepValidationError extends Error {
  override name = "StepValidationError";
  constructor(
    readonly step: string,
    readonly side: "input" | "output",
    readonly details: string,
  ) {
    super(`${step}: ${side} failed validation\n${details}`);
  }
}

export interface RunStepOptions {
  /**
   * A previous run's directory. Its saved output for this step is reused when the step version
   * is the same, the input is the same and the output is still valid. Anything else runs again.
   */
  resumeFromDir?: string;
}

interface SavedOutput {
  step: string;
  stepVersion: string;
  savedAt: string;
  output: unknown;
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/** JSON with sorted keys, so two equal inputs compare equal whatever order their keys came in. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

const writeJson = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/** Runs one step inside a run: validate input, run, validate output (retry), save output.json. */
export async function runStep<I extends z.ZodType, O extends z.ZodType>(
  run: RunStore,
  def: StepDefinition<I, O>,
  input: z.input<I>,
  opts: RunStepOptions = {},
): Promise<z.output<O>> {
  return run.step(def.name, async (ctx) => {
    const parsedInput = def.input.safeParse(input);
    if (!parsedInput.success) {
      throw new StepValidationError(def.name, "input", z.prettifyError(parsedInput.error));
    }
    writeJson(join(ctx.dir, "input.json"), parsedInput.data);

    if (opts.resumeFromDir) {
      const from = join(opts.resumeFromDir, def.name);
      const saved = readJson(join(from, "output.json")) as SavedOutput | null;
      // Why a saved output is not used is logged, so "it ran again" is never a mystery.
      let skip: string | undefined;
      if (!saved) skip = "the earlier run has no saved output for this step";
      else if (saved.stepVersion !== def.version) {
        skip = `the step changed since (version ${saved.stepVersion}, now ${def.version})`;
      } else if (stable(readJson(join(from, "input.json"))) !== stable(parsedInput.data)) {
        // Same step, other input: its output answers a different question.
        skip = "the input is not the same as in the earlier run";
      }
      if (saved && !skip) {
        const parsed = def.output.safeParse(saved.output);
        if (parsed.success) {
          writeJson(join(ctx.dir, "output.json"), { ...saved, resumedFrom: opts.resumeFromDir });
          ctx.log.event("info", "step.reused", "reused saved output", {
            from: opts.resumeFromDir,
            version: def.version,
          });
          return parsed.data;
        }
        ctx.log.warn("saved output no longer valid, running step again", {
          issues: z.prettifyError(parsed.error),
        });
      } else {
        ctx.log.info(`not reusing the earlier run: ${skip}`, { from: opts.resumeFromDir });
      }
    }

    const maxAttempts = def.maxAttempts ?? 1;
    let lastIssues = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const raw = await def.run(parsedInput.data, { ...ctx, attempt });
      const parsed = def.output.safeParse(raw);
      if (parsed.success) {
        const saved: SavedOutput = {
          step: def.name,
          stepVersion: def.version,
          savedAt: new Date().toISOString(),
          output: parsed.data,
        };
        writeJson(join(ctx.dir, "output.json"), saved);
        return parsed.data;
      }
      lastIssues = z.prettifyError(parsed.error);
      writeJson(join(ctx.dir, `invalid-output-${attempt}.json`), raw);
      ctx.log.warn("output failed validation", { attempt, maxAttempts, issues: lastIssues });
    }
    throw new StepValidationError(def.name, "output", lastIssues);
  });
}

/**
 * The version of a step as a run saved it, or undefined when the run has no output for it.
 * Read from the head of output.json: the version is written before the output itself, and the
 * output can be megabytes.
 */
export function savedStepVersion(runDir: string, step: string): string | undefined {
  const file = join(runDir, step, "output.json");
  if (!existsSync(file)) return undefined;
  const head = Buffer.alloc(512);
  const fd = openSync(file, "r");
  let length = 0;
  try {
    length = readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  return /"stepVersion":\s*"([^"]*)"/.exec(head.toString("utf8", 0, length))?.[1];
}
