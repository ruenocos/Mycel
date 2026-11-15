import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FakeProvider,
  GscClient,
  LlmClient,
  type LlmProvider,
  loadServiceAccount,
  OllamaProvider,
  WordPressClient,
} from "@mycel/connectors";
import {
  CORE_VERSION,
  cleanDomain,
  isReservedHost,
  MycelError,
  type ResearchPort,
  RunStore,
  researchSeedsStep,
  researchStep,
  runStep,
} from "@mycel/core";
import { ClientContext, type ResearchDataset, SitePages } from "@mycel/schema";
import { CONTEXT_FILE } from "./cluster.ts";
import { costLine, dataforseoFromEnv, KEYS_FIX, runBudget } from "./dataforseo.ts";
import { assertConfirmed, command, readInput } from "./input.ts";
import type { CommandResult } from "./run-command.ts";

/**
 * `mycel research <context.json>` (issue #16, Koray steps 7-8). Thin shell: reads pages and GSC,
 * builds the DataforSEO port, and lets core pick seeds and collect the dataset.
 */

export const PAGES_FILE = { name: "pages file", writtenBy: "a fixture (pages.json)" };

const day = (d: Date) => d.toISOString().slice(0, 10);
const isUrl = (s: string) => /^https?:\/\//i.test(s);

function providers(env: NodeJS.ProcessEnv): LlmProvider[] {
  const fake = new FakeProvider([], () => JSON.stringify({ seeds: [] }));
  const ollama = new OllamaProvider({
    host: env.OLLAMA_HOST ?? "https://ollama.com",
    ...(env.OLLAMA_API_KEY ? { apiKey: env.OLLAMA_API_KEY } : {}),
    timeoutMs: 300_000,
  });
  return [fake, ollama];
}

export interface ResearchOptions {
  runsDir: string;
  /** A confirmed context.json. */
  contextFile: string;
  /** Pages: a site URL (WordPress) or a fixture folder with pages.json. Default: the context's site. */
  site?: string;
  out?: string;
  provider: string;
  model: string;
  /** Deterministic seeds only. */
  noModel?: boolean;
  gsc?: boolean;
  /** Paid SERP calls (CLAUDE.md: explicit flag). Without it, only cached SERPs are used. */
  liveSerp?: boolean;
  budgetUsd?: number;
  /** Run on a context nobody confirmed yet (dry runs). */
  allowUnconfirmed?: boolean;
  cacheDir?: string;
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
  today?: Date;
  /** Tests pass a stub instead of DataforSEO. */
  port?: ResearchPort;
}

export interface ResearchResult extends CommandResult {
  runId: string;
  out?: string;
}

export function summarize(d: ResearchDataset): string[] {
  const lines: string[] = [];
  const by = (s: string) => d.queries.filter((q) => q.sources.includes(s as never)).length;
  lines.push(`seeds       ${d.seeds.length} (${d.seeds.map((s) => s.text).join(", ")})`);
  lines.push(`queries     ${d.queries.length} unique`);
  lines.push(
    `  sources   related ${by("dfs_related")}, suggestions ${by("dfs_suggestions")}, PAA ${by("serp_paa")}, related searches ${by("serp_related")}, GSC ${by("gsc")}, own ranked ${by("dfs_ranked_site")}, competitor ranked ${by("dfs_ranked_competitor")}`,
  );
  const aio = d.serps.filter((s) => s.aiOverview.present).length;
  lines.push(`serps       ${d.serps.length} (AI Overview on ${aio})`);
  const mined = d.competitors.filter((c) => c.mined);
  lines.push(`competitors ${mined.map((c) => c.domain).join(", ") || "(none)"}`);
  const fresh = d.competitors.filter((c) => !c.inContext && !c.platform && c.serpAppearances >= 2);
  if (fresh.length) {
    lines.push(
      `  new       ${fresh
        .slice(0, 12)
        .map((c) => `${c.domain} (${c.serpAppearances} SERPs)`)
        .join(", ")}`,
    );
    lines.push("            not in your context yet; add the real ones with mycel context confirm");
  }
  for (const w of d.warnings) lines.push(`warning     ${w}`);
  return lines;
}

export async function research(opts: ResearchOptions): Promise<ResearchResult> {
  const env = opts.env ?? process.env;
  const cacheDir = opts.cacheDir ?? ".cache";
  const lines: string[] = [];
  const budgetUsd = runBudget(opts.budgetUsd, 1);
  const context = readInput(opts.contextFile, ClientContext, CONTEXT_FILE);
  assertConfirmed(context, opts.contextFile, opts.allowUnconfirmed);
  const host = cleanDomain(new URL(context.site.url).hostname);
  const run = RunStore.create({
    runsDir: opts.runsDir,
    client: host,
    command: "research",
    cliVersion: CORE_VERSION,
    config: {
      context: opts.contextFile,
      site: opts.site ?? context.site.url,
      model: opts.noModel ? null : opts.model,
      provider: opts.provider,
      liveSerp: !!opts.liveSerp,
      budgetUsd,
    },
    ...(opts.debug ? { consoleLevel: "debug" as const } : {}),
  });
  if (!context.confirmed) lines.push("note        context is not confirmed: dry run");

  const dfs = dataforseoFromEnv(env, { cacheDir, budgetUsd, allowLiveSerp: !!opts.liveSerp });
  const port: ResearchPort | undefined = opts.port ?? dfs;

  let out: string | undefined;
  let failure: unknown;
  try {
    if (!port) {
      throw new MycelError("KEY_MISSING", "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set", {
        fix: KEYS_FIX,
      });
    }
    const data = port;
    const sources = await run.step("research-sources", async (ctx) => {
      const site = opts.site ?? context.site.url;
      let pages: SitePages["pages"];
      if (isUrl(site)) {
        if (isReservedHost(cleanDomain(new URL(site).hostname))) {
          throw new MycelError("USAGE", `${site} is a test domain, so it has no pages to read`, {
            fix: "pass --site <fixture folder> for its pages",
          });
        }
        const wp = new WordPressClient({
          baseUrl: new URL(site).origin,
          cacheDir: join(cacheDir, "wordpress"),
        });
        pages = (await wp.readSite(ctx)).pages;
      } else {
        pages = readInput(join(site, "pages.json"), SitePages, PAGES_FILE).pages;
      }
      let gscRows:
        | { query: string; clicks: number; impressions: number; position: number }[]
        | undefined;
      const property = env.GSC_PROPERTY;
      if (opts.gsc !== false && env.GSC_CREDENTIALS_PATH && property?.includes(host)) {
        const gsc = new GscClient({
          credentials: loadServiceAccount(env.GSC_CREDENTIALS_PATH),
          property,
        });
        const end = new Date((opts.today ?? new Date()).getTime() - 3 * 86_400_000);
        const start = new Date(end.getTime() - 89 * 86_400_000);
        const rows = await gsc.searchAnalytics(
          { startDate: day(start), endDate: day(end), dimensions: ["query"], maxRows: 1000 },
          ctx,
        );
        gscRows = rows.map((r) => ({
          query: r.keys.query ?? "",
          clicks: r.clicks,
          impressions: r.impressions,
          position: r.position,
        }));
      } else if (opts.gsc !== false) {
        ctx.log.warn("GSC skipped: no credentials, or GSC_PROPERTY is not this site", {
          host,
          property: property ?? null,
        });
      }
      return {
        pages: pages.map((p) => ({ url: p.url, kind: p.kind, title: p.title, h1: p.h1 })),
        gscRows,
      };
    });

    // The client's own ranked keywords feed the seeds; the call is cached, so collect reuses it.
    const ownRanked = isReservedHost(host)
      ? []
      : await run.step("research-own-ranked", (ctx) =>
          data.rankedKeywords(host, context.market, ctx),
        );

    const llm = new LlmClient({ providers: providers(env), defaultProvider: opts.provider });
    const seeds = await runStep(run, researchSeedsStep(llm), {
      context,
      data: {
        ...(sources.gscRows
          ? {
              gscQueries: sources.gscRows.map((r) => ({
                query: r.query,
                impressions: r.impressions,
              })),
            }
          : {}),
        rankedKeywords: ownRanked.map((k) => ({
          keyword: k.keyword,
          ...(k.volume !== undefined ? { volume: k.volume } : {}),
          ...(k.position !== undefined ? { position: k.position } : {}),
        })),
      },
      model: opts.model,
      noModel: !!opts.noModel,
    });

    const dataset = await runStep(run, researchStep(data), {
      context,
      seeds,
      pages: sources.pages,
      ...(sources.gscRows ? { gscRows: sources.gscRows } : {}),
    });
    out = opts.out ?? join(dirname(opts.contextFile), "research.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(dataset, null, 2)}\n`);
    lines.push(...summarize(dataset));
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
      ? { out, outputs: { research: out }, next: [{ command: command("filter", out) }] }
      : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
}
