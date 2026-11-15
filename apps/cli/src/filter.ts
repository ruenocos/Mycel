import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FakeProvider, LlmClient, type LlmProvider, OllamaProvider } from "@mycel/connectors";
import {
  CORE_VERSION,
  type FilterEvalScore,
  filterStep,
  MycelError,
  RunStore,
  runStep,
  scoreFilterEval,
} from "@mycel/core";
import {
  ClientContext,
  FilterEvalSet,
  type FilteredQueries,
  normalizeQuery,
  ResearchDataset,
} from "@mycel/schema";
import { CONTEXT_FILE } from "./cluster.ts";
import { assertConfirmed, command, readInput } from "./input.ts";
import type { CommandResult } from "./run-command.ts";

/**
 * `mycel filter` and `mycel eval filter` (issue #17, Koray step 9). Thin shell around core's
 * filter step: rules first, then the model labels what's left.
 */

/** The fake model keeps everything as related, for dry runs and tests. */
function providers(env: NodeJS.ProcessEnv): LlmProvider[] {
  const fake = new FakeProvider([], (req) => {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";
    const n = user.split("\nQueries:\n")[1]?.split("\n").filter(Boolean).length ?? 0;
    return JSON.stringify({
      results: Array.from({ length: n }, (_, i) => ({ i, label: "outer", why: "fake" })),
    });
  });
  const ollama = new OllamaProvider({
    host: env.OLLAMA_HOST ?? "https://ollama.com",
    ...(env.OLLAMA_API_KEY ? { apiKey: env.OLLAMA_API_KEY } : {}),
    timeoutMs: 300_000,
  });
  return [fake, ollama];
}

export const RESEARCH_FILE = { name: "research file", writtenBy: "mycel research" };
const EVAL_SET = { name: "filter eval set", writtenBy: "hand, in a fixture folder" };

export function summarizeFilter(d: FilteredQueries): string[] {
  const lines = [`queries     ${d.stats.total}, kept ${d.stats.kept}`];
  const drops = Object.entries(d.stats.dropped)
    .sort(([, a], [, b]) => b - a)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  if (drops) lines.push(`dropped     ${drops}`);
  const kept = d.queries.filter((q) => q.filter?.kept);
  const core = kept.filter((q) => q.label === "core").length;
  lines.push(`kept        core ${core}, related ${kept.length - core}`);
  const top = [...kept]
    .sort(
      (a, b) =>
        (b.scores?.relevance ?? 0) * (b.scores?.popularity ?? 0) -
        (a.scores?.relevance ?? 0) * (a.scores?.popularity ?? 0),
    )
    .slice(0, 8)
    .map((q) => q.text);
  if (top.length) lines.push(`top         ${top.join(", ")}`);
  return lines;
}

export interface FilterOptions {
  runsDir: string;
  researchFile: string;
  /** Default: context.json next to the research file. */
  contextFile?: string;
  out?: string;
  provider: string;
  model: string;
  allowUnconfirmed?: boolean;
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface FilterResult extends CommandResult {
  runId: string;
  out?: string;
}

export async function filterRun(opts: FilterOptions): Promise<FilterResult> {
  const env = opts.env ?? process.env;
  const research = readInput(opts.researchFile, ResearchDataset, RESEARCH_FILE);
  const contextFile = opts.contextFile ?? join(dirname(opts.researchFile), "context.json");
  const context = readInput(contextFile, ClientContext, CONTEXT_FILE);
  assertConfirmed(context, contextFile, opts.allowUnconfirmed);
  const run = RunStore.create({
    runsDir: opts.runsDir,
    client: new URL(research.site.url).hostname,
    command: "filter",
    cliVersion: CORE_VERSION,
    config: { research: opts.researchFile, context: contextFile, model: opts.model },
    ...(opts.debug ? { consoleLevel: "debug" as const } : {}),
  });
  const lines: string[] = [];
  if (!context.confirmed) lines.push("note        context is not confirmed: dry run");
  let out: string | undefined;
  let failure: unknown;
  try {
    const llm = new LlmClient({ providers: providers(env), defaultProvider: opts.provider });
    const result = await runStep(run, filterStep(llm), {
      context,
      site: research.site,
      queries: research.queries,
      model: opts.model,
    });
    out = opts.out ?? join(dirname(opts.researchFile), "queries.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    lines.push(...summarizeFilter(result));
  } catch (err) {
    failure = err;
  }
  const meta = run.finish(failure);
  return {
    runId: run.runId,
    ok: meta.status === "ok",
    lines,
    ...(out
      ? {
          out,
          outputs: { queries: out },
          next: [
            {
              command: command("cluster", out),
              note: "uses cached SERPs only; add --live-serp --budget <usd> to buy the missing ones",
            },
          ],
        }
      : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
}

/**
 * The two labeled sets per test client. The tuning set is the one to look at while changing the
 * prompt or the rules. The held-out set is only ever scored, never tuned on: it shows whether a
 * change helps on queries nobody looked at, or only on the ones it was fitted to.
 */
export const FILTER_EVAL_SETS = [
  { kind: "tuning", file: "filter-eval.json" },
  { kind: "held-out", file: "filter-holdout.json" },
] as const;
export type FilterEvalKind = (typeof FILTER_EVAL_SETS)[number]["kind"];

/** Share of labeled queries the filter must get right, per set. */
export const DEFAULT_MIN_ACCURACY = 0.9;

export interface FilterEvalOptions {
  runsDir: string;
  /** Fixture folders with context.json, filter-eval.json and (optional) filter-holdout.json. */
  fixtures: string[];
  provider: string;
  model: string;
  /** Pass mark per set, 0 to 1. Below it the eval fails. */
  minAccuracy?: number;
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface FilterEvalSetScore extends FilterEvalScore {
  set: FilterEvalKind;
  passed: boolean;
}

export async function filterEval(
  opts: FilterEvalOptions,
): Promise<CommandResult & { scores: FilterEvalSetScore[] }> {
  const env = opts.env ?? process.env;
  const minAccuracy = opts.minAccuracy ?? DEFAULT_MIN_ACCURACY;
  if (!(minAccuracy >= 0 && minAccuracy <= 1)) {
    throw new MycelError(
      "USAGE",
      `--min-accuracy must be between 0 and 1, got ${opts.minAccuracy}`,
    );
  }
  const llm = new LlmClient({ providers: providers(env), defaultProvider: opts.provider });
  const scores: FilterEvalSetScore[] = [];
  const lines: string[] = [];
  let ok = true;
  let crashed: unknown;
  for (const dir of opts.fixtures) {
    const context = readInput(join(dir, "context.json"), ClientContext, CONTEXT_FILE);
    for (const { kind, file } of FILTER_EVAL_SETS) {
      if (kind === "held-out" && !existsSync(join(dir, file))) {
        lines.push(`${basename(dir).padEnd(24)} ${kind.padEnd(8)} no ${file}: not scored`);
        continue;
      }
      const set = readInput(join(dir, file), FilterEvalSet, EVAL_SET);
      const run = RunStore.create({
        runsDir: opts.runsDir,
        client: set.client,
        command: "eval filter",
        cliVersion: CORE_VERSION,
        config: { fixture: dir, set: kind, model: opts.model, minAccuracy },
        ...(opts.debug ? { consoleLevel: "debug" as const } : {}),
      });
      let failure: unknown;
      try {
        const result = await runStep(run, filterStep(llm), {
          context,
          site: context.site,
          queries: set.cases.map((c) => ({
            text: c.query,
            normalized: normalizeQuery(c.query),
            sources: ["seed" as const],
          })),
          model: opts.model,
        });
        const s = scoreFilterEval(set, result);
        const passed = s.accuracy >= minAccuracy;
        scores.push({ ...s, set: kind, passed });
        if (!passed) ok = false;
        lines.push(
          `${s.client.padEnd(24)} ${kind.padEnd(8)} ${passed ? "pass" : "FAIL"}  accuracy ${s.accuracy} (needs ${minAccuracy})  precision ${s.precision}  recall ${s.recall}  (${s.cases} cases, run ${run.runId})`,
        );
        for (const m of s.misses) {
          lines.push(
            `  miss  "${m.query}": expected ${m.expected}, got ${m.got}${m.reason ? ` (${m.reason})` : ""}. Label: ${m.why}`,
          );
        }
      } catch (err) {
        failure = err;
        crashed ??= err;
        lines.push(`${set.client.padEnd(24)} ${kind.padEnd(8)} failed: ${(err as Error).message}`);
      }
      if (run.finish(failure).status !== "ok") ok = false;
    }
  }
  const below = scores.filter((s) => !s.passed);
  if (below.length) {
    lines.push(
      "Below the pass mark. Fix the prompt or rules on the tuning set only; never fit them to the held-out misses.",
    );
  }
  // A set that could not be scored is a failed run; a set that scored too low is a missed mark.
  const failure =
    crashed ??
    (below.length
      ? new MycelError(
          "BELOW_PASS_MARK",
          `${below.length} of ${scores.length} eval sets are below the pass mark of ${minAccuracy}`,
          { fix: "see the misses above; tune on the tuning set only" },
        )
      : undefined);
  return { ok, scores, lines, ...(failure !== undefined ? { failure } : {}) };
}
