import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CORE_VERSION,
  clusterStep,
  formatTimeline,
  RunStore,
  runStep,
  type SerpBatchPort,
} from "@mycel/core";
import { ClientContext, type ClusterSet, FilteredQueries } from "@mycel/schema";
import { costLine, dataforseoFromEnv, runBudget } from "./dataforseo.ts";

/**
 * `mycel cluster <queries.json>` (issue #18, Koray step 10). Thin shell: fetches a SERP per kept
 * query in batches, then core clusters on SERP overlap and applies the QDP rule.
 */

const readJson = (path: string) => {
  if (!existsSync(path)) throw new Error(`no file at ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
};

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
  budgetUsd?: number;
  minShared?: number;
  allowUnconfirmed?: boolean;
  cacheDir?: string;
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Tests pass a stub instead of DataforSEO. */
  port?: SerpBatchPort;
}

export interface ClusterResult {
  runId: string;
  ok: boolean;
  out?: string;
  lines: string[];
  timeline: string;
}

export async function clusterRun(opts: ClusterOptionsCli): Promise<ClusterResult> {
  const env = opts.env ?? process.env;
  const budgetUsd = runBudget(opts.budgetUsd, 3);
  if (opts.minShared !== undefined && !(Number.isInteger(opts.minShared) && opts.minShared > 0)) {
    throw new Error(`--min-shared must be a positive whole number, got ${opts.minShared}`);
  }
  const queries = FilteredQueries.parse(readJson(opts.queriesFile));
  const contextFile = opts.contextFile ?? join(dirname(opts.queriesFile), "context.json");
  const context = ClientContext.parse(readJson(contextFile));
  if (!context.confirmed && !opts.allowUnconfirmed) {
    throw new Error(
      `${contextFile} isn't confirmed yet; run mycel context confirm first (or --allow-unconfirmed for a dry run)`,
    );
  }
  const dfs = dataforseoFromEnv(env, {
    cacheDir: opts.cacheDir ?? ".cache",
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
  if (!context.confirmed) lines.push("note        context is not confirmed: dry run");
  let out: string | undefined;
  let failure: unknown;
  try {
    if (!port) throw new Error("DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set");
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
    lines.push(`clusters    ${out}`);
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
