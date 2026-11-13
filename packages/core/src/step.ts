import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  /** A previous run's directory; its saved output for this step is reused when valid and same version. */
  resumeFromDir?: string;
}

interface SavedOutput {
  step: string;
  stepVersion: string;
  savedAt: string;
  output: unknown;
}

function readSaved(path: string): SavedOutput | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as SavedOutput;
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
    if (opts.resumeFromDir) {
      const saved = readSaved(join(opts.resumeFromDir, def.name, "output.json"));
      if (saved && saved.stepVersion === def.version) {
        const parsed = def.output.safeParse(saved.output);
        if (parsed.success) {
          writeJson(join(ctx.dir, "output.json"), { ...saved, resumedFrom: opts.resumeFromDir });
          ctx.log.info("reused saved output", { from: opts.resumeFromDir, version: def.version });
          return parsed.data;
        }
        ctx.log.warn("saved output no longer valid, running step again", {
          issues: z.prettifyError(parsed.error),
        });
      }
    }

    const parsedInput = def.input.safeParse(input);
    if (!parsedInput.success) {
      throw new StepValidationError(def.name, "input", z.prettifyError(parsedInput.error));
    }
    writeJson(join(ctx.dir, "input.json"), parsedInput.data);

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
