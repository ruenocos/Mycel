import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FileCache, historyPlan, SitemapReader } from "@mycel/connectors";
import {
  CORE_VERSION,
  monthStart,
  pageSearches,
  RunStore,
  runStep,
  type SitemapPort,
  signalsStep,
  type TrendsPort,
  trendTopics,
} from "@mycel/core";
import {
  ClientContext,
  ClusterSet,
  FilteredQueries,
  ResearchDataset,
  type SignalSet,
} from "@mycel/schema";
import { readProfile } from "./business.ts";
import { CONTEXT_FILE, QUERIES_FILE } from "./cluster.ts";
import {
  budgetLine,
  costLine,
  DRY_RUN,
  dataforseoFromEnv,
  monthlyBudget,
  runBudget,
} from "./dataforseo.ts";
import { RESEARCH_FILE } from "./filter.ts";
import { assertConfirmed, command, readInput } from "./input.ts";
import type { CommandResult } from "./run-command.ts";

/**
 * `mycel signals <clusters.json>` (issue #63): the open Koray map steps as data for the map.
 * Trends (step 14) and competitors' sitemaps (steps 8 and 11). Thin shell around core's step.
 *
 * Sitemaps are free. Monthly searches and Google Trends cost a few cents and are only bought
 * with --buy; without it the step uses what the cache already holds.
 */

const CLUSTERS_FILE = { name: "clusters file", writtenBy: "mycel cluster" };

const pct = (x: number) => `${x > 0 ? "+" : ""}${Math.round(x * 100)}%`;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function summarizeSignals(d: SignalSet): string[] {
  const lines: string[] = [];
  const t = d.trends;
  if (t) {
    const count = (l: string) => t.clusters.filter((c) => c.label === l).length;
    lines.push(
      `trends      ${t.coverage.withTrend} of ${t.coverage.clusters} pages with a trend: ${count("rising")} rising, ${count("falling")} falling, ${count("seasonal")} seasonal, ${count("steady")} steady`,
    );
    const rising = t.clusters
      .filter((c) => c.label === "rising" && c.change !== undefined)
      .sort((a, b) => (b.change ?? 0) - (a.change ?? 0))
      .slice(0, 5)
      .map((c) => `${c.mainQuery} ${pct(c.change ?? 0)}`);
    if (rising.length) lines.push(`rising      ${rising.join(", ")}`);
    if (t.topics.length) {
      lines.push(
        `topics      ${t.topics.map((x) => `${x.keyword} ${x.label}${x.change !== undefined ? ` ${pct(x.change)}` : ""}${x.peakMonths.length ? ` (peak ${x.peakMonths.map((m) => MONTHS[m - 1]).join("/")})` : ""}`).join(", ")}`,
      );
    }
    if (t.ideas.length) {
      lines.push(
        `trend ideas ${t.ideas
          .slice(0, 5)
          .map((i) => i.query)
          .join(", ")}`,
      );
    }
  }
  const c = d.competitors;
  if (c) {
    for (const s of c.sites) {
      lines.push(
        s.status === "ok"
          ? `competitor  ${s.domain}: ${s.pages}${s.truncated ? "+" : ""} pages, ${s.dated ? `${s.perMonth} changed a month` : "no usable dates"}`
          : `competitor  ${s.domain}: sitemap ${s.status}${s.reason ? ` (${s.reason})` : ""}`,
      );
    }
    lines.push(`depth       ${c.coverage.length} page topics have a competitor page`);
    if (c.gaps.length) {
      lines.push(
        `gaps        ${c.gaps
          .slice(0, 6)
          .map((g) => `${g.topic} (${g.competitors.length})`)
          .join(", ")}`,
      );
    }
  }
  for (const w of d.warnings) lines.push(`note        ${w}`);
  return lines;
}

export interface SignalsOptions {
  runsDir: string;
  clustersFile: string;
  /** Default: queries.json next to the clusters file, when it exists. */
  queriesFile?: string;
  /** Default: context.json next to the clusters file. */
  contextFile?: string;
  /** Default: research.json next to the clusters file, when it exists (competitor candidates). */
  researchFile?: string;
  out?: string;
  /** Buy monthly searches and Google Trends that aren't cached. */
  buy?: boolean;
  /** Skip competitors' sitemaps. */
  noSitemaps?: boolean;
  dryRun?: boolean;
  budgetUsd?: number;
  cacheDir?: string;
  allowUnconfirmed?: boolean;
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Tests pass stubs. */
  ports?: { keywords?: TrendsPort; sitemaps?: SitemapPort };
  now?: string;
}

export interface SignalsResult extends CommandResult {
  runId?: string;
  out?: string;
}

export async function signalsRun(opts: SignalsOptions): Promise<SignalsResult> {
  const env = opts.env ?? process.env;
  const budgetUsd = runBudget(opts.budgetUsd, 0.5);
  const dir = dirname(opts.clustersFile);
  const clusters = readInput(opts.clustersFile, ClusterSet, CLUSTERS_FILE);
  const contextFile = opts.contextFile ?? join(dir, "context.json");
  const read = readInput(contextFile, ClientContext, CONTEXT_FILE);
  assertConfirmed(read, contextFile, opts.allowUnconfirmed);
  const businessFile = join(dirname(contextFile), "business.json");
  const business =
    read.business ?? (existsSync(businessFile) ? readProfile(businessFile) : undefined);
  const context: ClientContext = business ? { ...read, business } : read;
  const queriesFile =
    opts.queriesFile ??
    (existsSync(join(dir, "queries.json")) ? join(dir, "queries.json") : undefined);
  const queries = queriesFile ? readInput(queriesFile, FilteredQueries, QUERIES_FILE).queries : [];
  const researchFile =
    opts.researchFile ??
    (existsSync(join(dir, "research.json")) ? join(dir, "research.json") : undefined);
  const competitors = researchFile
    ? readInput(researchFile, ResearchDataset, RESEARCH_FILE).competitors
    : [];
  const cacheDir = opts.cacheDir ?? ".cache";
  const now = opts.now ? new Date(opts.now) : new Date();
  const plan = historyPlan(new FileCache(join(cacheDir, "dataforseo")), {
    keywords: pageSearches(clusters),
    topics: trendTopics(context),
    market: context.market,
    dateFrom: monthStart(now, 24),
  });
  const planLines = [
    `searches    ${plan.ads.calls} Google Ads call(s) for monthly searches, ${plan.ads.toBuy} to buy`,
    `trends      ${plan.trends.calls} Google Trends call(s), ${plan.trends.toBuy} to buy`,
    `sitemaps    ${opts.noSitemaps ? "skipped" : "free, read from the competitors' own sites"}`,
  ];
  const toBuy = plan.ads.toBuy + plan.trends.toBuy;

  if (opts.dryRun) {
    const lines = [DRY_RUN, ...planLines];
    if (toBuy) {
      const dfs = dataforseoFromEnv(env, { cacheDir, budgetUsd });
      lines.push(
        `cost        about $${plan.estimateUsd.toFixed(4)} with --buy (list prices)`,
        budgetLine(plan.estimateUsd, budgetUsd, dfs?.spentThisMonthUsd ?? 0, monthlyBudget(env)),
      );
    } else lines.push("cost        $0.0000: nothing to buy");
    return {
      ok: true,
      lines,
      data: { plan, budgetUsd },
      next: toBuy
        ? [
            { note: "the same command without --dry-run uses only what is cached ($0)" },
            { note: `adding --buy --budget ${budgetUsd} buys the rest: buying is a person's call` },
          ]
        : [{ note: "the same command without --dry-run: it buys nothing" }],
    };
  }

  const dfs = dataforseoFromEnv(env, { cacheDir, budgetUsd });
  const keywords: TrendsPort | undefined = opts.ports?.keywords ?? dfs;
  const sitemaps: SitemapPort | undefined = opts.noSitemaps
    ? undefined
    : (opts.ports?.sitemaps ?? new SitemapReader({ cacheDir: join(cacheDir, "sitemaps") }));
  const run = RunStore.create({
    runsDir: opts.runsDir,
    client: new URL(clusters.site.url).hostname,
    command: "signals",
    cliVersion: CORE_VERSION,
    config: {
      clusters: opts.clustersFile,
      queries: queriesFile ?? null,
      research: researchFile ?? null,
      context: contextFile,
      buy: !!opts.buy,
      budgetUsd,
      sitemaps: !opts.noSitemaps,
    },
    ...(opts.debug ? { consoleLevel: "debug" as const } : {}),
  });
  const lines: string[] = [];
  if (!context.confirmed) lines.push("note        context is not confirmed: trial run");
  if (!keywords) lines.push("note        no DataforSEO keys: no trends");
  if (!researchFile) lines.push("note        no research.json: only the confirmed competitors");
  // Without --buy only fully cached calls run: nothing is bought by accident.
  const adsHistory = !!opts.buy || (plan.ads.calls > 0 && plan.ads.toBuy === 0);
  const explore = !!opts.buy || (plan.trends.calls > 0 && plan.trends.toBuy === 0);
  if (!opts.buy && toBuy) {
    lines.push(
      `note        ${toBuy} paid call(s) not cached: trends from cached data only (--buy buys them)`,
    );
  }
  let out: string | undefined;
  let failure: unknown;
  try {
    const result = await runStep(
      run,
      signalsStep({
        ...(keywords ? { keywords } : {}),
        ...(sitemaps ? { sitemaps } : {}),
      }),
      {
        context,
        clusters,
        queries,
        competitors,
        now: now.toISOString(),
        adsHistory,
        explore,
        sitemaps: !opts.noSitemaps,
      },
    );
    out = opts.out ?? join(dir, "signals.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    lines.push(...summarizeSignals(result));
    if (dfs) lines.push(costLine(dfs, budgetUsd, env));
  } catch (err) {
    failure = err;
  }
  const meta = run.finish(failure);
  return {
    runId: run.runId,
    ok: meta.status === "ok",
    lines,
    ...(out
      ? { out, outputs: { signals: out }, next: [{ command: command("map", opts.clustersFile) }] }
      : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
}
