import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { planSerpBatch } from "@mycel/connectors";
import {
  CORE_VERSION,
  clusterSerpQueries,
  clusterStep,
  MycelError,
  RunStore,
  runStep,
  type SerpBatchPort,
} from "@mycel/core";
import { ClientContext, type ClusterSet, FilteredQueries } from "@mycel/schema";
import { costLine, dataforseoFromEnv, KEYS_FIX, runBudget, serpPlanLines } from "./dataforseo.ts";
import { assertConfirmed, command, readInput } from "./input.ts";
import type { CommandResult } from "./run-command.ts";

/**
 * `mycel cluster <queries.json>` (issue #18, Koray step 10). Thin shell: fetches a SERP per kept
 * query in batches, then core clusters on SERP overlap and applies the QDP rule.
 */

export const QUERIES_FILE = { name: "queries file", writtenBy: "mycel filter" };
export const CONTEXT_FILE = { name: "context", writtenBy: "mycel context propose" };

const tierRank = (l: string) => (l === "core" ? 0 : l === "outer" ? 1 : 2);

export function summarizeClusters(d: ClusterSet): string[] {
  const s = d.stats;
  const lines = [
    `queries     ${s.queries} kept, ${s.clustered} clustered, ${d.unclustered.length - s.leftOut} without a SERP, ${s.leftOut} left out (bridges with no host)`,
    `clusters    ${s.clusters}: ${s.pages} pages, ${s.sections} sections, ${s.micro} micro`,
    `review      ${s.outliers} flagged, ${s.ambiguousMembers} ambiguous, ${s.borderlineMembers} borderline (exactly ${d.minSharedUrls} shared)`,
    `singletons  ${s.singletons} of ${s.clusters} clusters have one query (${s.merged} merged as variants or same intent)`,
    `bridges     ${s.bridges} broader topics mentioned on a page instead of their own`,
  ];
  const pages = d.clusters
    .filter((c) => c.qdp === "page")
    // Core before outer, then demand (doc 02, step 9: relevance before volume).
    .sort((a, b) => tierRank(a.label) - tierRank(b.label) || b.demand.volume - a.demand.volume)
    .slice(0, 10)
    .map((c) => `${c.mainQuery} (${c.label}, ${c.members.length}, ${c.demand.volume}/mo)`);
  if (pages.length) lines.push(`top pages   ${pages.join(", ")}`);
  const aio = d.clusters.filter((c) => c.qdp === "page" && c.aiOverview.present);
  const cited = aio.filter((c) => c.aiOverview.cited).length;
  lines.push(`AI Overview on ${aio.length} page topics, client cited in ${cited}`);
  return lines;
}

export interface ClusterOptionsCli {
  runsDir: string;
  queriesFile: string;
  /** Default: context.json next to the queries file. */
  contextFile?: string;
  out?: string;
  liveSerp?: boolean;
  /** Count what the run would buy and stop: no run, no paid call, no file. */
  dryRun?: boolean;
  budgetUsd?: number;
  minShared?: number;
  allowUnconfirmed?: boolean;
  cacheDir?: string;
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Tests pass a stub instead of DataforSEO. */
  port?: SerpBatchPort;
}

export interface ClusterResult extends CommandResult {
  /** Absent for a dry run: nothing ran. */
  runId?: string;
  out?: string;
}

export async function clusterRun(opts: ClusterOptionsCli): Promise<ClusterResult> {
  const env = opts.env ?? process.env;
  const budgetUsd = runBudget(opts.budgetUsd, 3);
  if (opts.minShared !== undefined && !(Number.isInteger(opts.minShared) && opts.minShared > 0)) {
    throw new MycelError(
      "USAGE",
      `--min-shared must be a positive whole number, got ${opts.minShared}`,
    );
  }
  const queries = readInput(opts.queriesFile, FilteredQueries, QUERIES_FILE);
  const contextFile = opts.contextFile ?? join(dirname(opts.queriesFile), "context.json");
  const context = readInput(contextFile, ClientContext, CONTEXT_FILE);
  assertConfirmed(context, contextFile, opts.allowUnconfirmed);
  const cacheDir = opts.cacheDir ?? ".cache";
  if (opts.dryRun) {
    const plan = planSerpBatch(
      join(cacheDir, "dataforseo"),
      clusterSerpQueries(queries),
      context.market,
    );
    // The command isn't rebuilt here: the caller knows its own flags, and a rebuilt one that
    // dropped a flag would be worse than none.
    const next = plan.toBuy
      ? [
          {
            note: `the same command without --dry-run, plus --live-serp --budget ${budgetUsd} to buy what is missing`,
          },
          { note: "buying is a person's call: ask before running it" },
        ]
      : [{ note: "the same command without --dry-run: it buys nothing" }];
    return {
      ok: true,
      lines: serpPlanLines(plan, budgetUsd, env, "one per kept query"),
      data: { plan: { ...plan }, budgetUsd },
      next,
    };
  }
  const dfs = dataforseoFromEnv(env, {
    cacheDir,
    budgetUsd,
    allowLiveSerp: !!opts.liveSerp,
  });
  const port = opts.port ?? dfs;
  const run = RunStore.create({
    runsDir: opts.runsDir,
    client: new URL(queries.site.url).hostname,
    command: "cluster",
    cliVersion: CORE_VERSION,
    config: {
      queries: opts.queriesFile,
      context: contextFile,
      liveSerp: !!opts.liveSerp,
      budgetUsd,
      minShared: opts.minShared ?? null,
    },
    ...(opts.debug ? { consoleLevel: "debug" as const } : {}),
  });
  const lines: string[] = [];
  if (!context.confirmed) lines.push("note        context is not confirmed: trial run");
  let out: string | undefined;
  let failure: unknown;
  try {
    if (!port)
      throw new MycelError("KEY_MISSING", "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set", {
        fix: KEYS_FIX,
      });
    const result = await runStep(run, clusterStep(port), {
      context,
      queries,
      options: opts.minShared ? { minShared: opts.minShared } : {},
    });
    out = opts.out ?? join(dirname(opts.queriesFile), "clusters.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    lines.push(...summarizeClusters(result));
    if (dfs) lines.push(costLine(dfs, budgetUsd, env));
  } catch (err) {
    failure = err;
  }
  const meta = run.finish(failure);
  return {
    runId: run.runId,
    ok: meta.status === "ok",
    lines,
    ...(out ? { out, outputs: { clusters: out }, next: [{ command: command("map", out) }] } : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
}
