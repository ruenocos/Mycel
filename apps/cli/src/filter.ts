import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FakeProvider, LlmClient, type LlmProvider, OllamaProvider } from "@mycel/connectors";
import {
  CORE_VERSION,
  type FilterEvalScore,
  filterStep,
  formatTimeline,
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

const readJson = (path: string) => {
  if (!existsSync(path)) throw new Error(`no file at ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
};

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

export interface FilterResult {
  runId: string;
  ok: boolean;
  out?: string;
  lines: string[];
  timeline: string;
}

export async function filterRun(opts: FilterOptions): Promise<FilterResult> {
  const env = opts.env ?? process.env;
  const research = ResearchDataset.parse(readJson(opts.researchFile));
  const contextFile = opts.contextFile ?? join(dirname(opts.researchFile), "context.json");
  const context = ClientContext.parse(readJson(contextFile));
  if (!context.confirmed && !opts.allowUnconfirmed) {
    throw new Error(
      `${contextFile} isn't confirmed yet; run mycel context confirm first (or --allow-unconfirmed for a dry run)`,
    );
  }
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
    lines.push(`queries     ${out}`);
  } catch (err) {
    failure = err;
  }
  const meta = run.finish(failure);
  if (failure) lines.push(`failed      ${(failure as Error).message}`);
  return {
    runId: run.runId,
    ok: meta.status === "ok",
    ...(out ? { out } : {}),
    lines,
    timeline: formatTimeline(opts.runsDir, run.runId),
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
): Promise<{ ok: boolean; scores: FilterEvalSetScore[]; lines: string[] }> {
  const env = opts.env ?? process.env;
  const minAccuracy = opts.minAccuracy ?? DEFAULT_MIN_ACCURACY;
  if (!(minAccuracy >= 0 && minAccuracy <= 1)) {
    throw new Error(`--min-accuracy must be between 0 and 1, got ${opts.minAccuracy}`);
  }
  const llm = new LlmClient({ providers: providers(env), defaultProvider: opts.provider });
  const scores: FilterEvalSetScore[] = [];
  const lines: string[] = [];
  let ok = true;
  for (const dir of opts.fixtures) {
    const context = ClientContext.parse(readJson(join(dir, "context.json")));
    for (const { kind, file } of FILTER_EVAL_SETS) {
      if (kind === "held-out" && !existsSync(join(dir, file))) {
        lines.push(`${basename(dir).padEnd(24)} ${kind.padEnd(8)} no ${file}: not scored`);
        continue;
      }
      const set = FilterEvalSet.parse(readJson(join(dir, file)));
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
        lines.push(`${set.client.padEnd(24)} ${kind.padEnd(8)} failed: ${(err as Error).message}`);
      }
      if (run.finish(failure).status !== "ok") ok = false;
    }
  }
  if (scores.some((s) => !s.passed)) {
    lines.push(
      "Below the pass mark. Fix the prompt or rules on the tuning set only; never fit them to the held-out misses.",
    );
  }
  return { ok, scores, lines };
}
