import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FakeProvider, LlmClient, type LlmProvider, OllamaProvider } from "@mycel/connectors";
import {
  CORE_VERSION,
  checkGate,
  formatTimeline,
  type GateResult,
  mapStep,
  type PageRef,
  RunStore,
  runStep,
} from "@mycel/core";
import {
  ClientContext,
  ClusterSet,
  FilteredQueries,
  GateExpectations,
  type SiteMaps,
} from "@mycel/schema";

/**
 * `mycel map <clusters.json>` (issue #19, Koray steps 11-14 and 20). Thin shell around core's map
 * step: data builds the tree, the model names each page and places pages whose words don't nest.
 */

/**
 * The fake model labels every page and leaves hubs at the root; asked to link existing pages,
 * it picks each page's first likely map page, else "none".
 */
function providers(env: NodeJS.ProcessEnv): LlmProvider[] {
  const fake = new FakeProvider([], (req) => {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";
    if (user.includes("\nMap pages:\n")) {
      const existing = JSON.parse(user.split("\nExisting pages:\n")[1] ?? "[]") as {
        p: number;
        likely?: string[];
      }[];
      return JSON.stringify({
        results: existing.map((e) => ({ p: e.p, node: e.likely?.[0] ?? "none" })),
      });
    }
    const pages = JSON.parse(user.split("\nPages:\n")[1] ?? "[]") as { i: number; page: string }[];
    return JSON.stringify({
      results: pages.map((p) => ({
        i: p.i,
        attribute: p.page,
        macroContext: p.page,
        why: `fake label for ${p.page}`,
        parent: "root",
      })),
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

/** Pages from a pages.json (fixture or WordPress read) or a research.json. */
function readPages(path: string): PageRef[] {
  const raw = readJson(path) as { pages?: unknown };
  if (!Array.isArray(raw.pages)) throw new Error(`${path} has no pages list`);
  return raw.pages as PageRef[];
}

export function summarizeMaps(d: SiteMaps): string[] {
  const lines: string[] = [];
  for (const m of d.maps) {
    const n = m.nodes;
    const count = (f: (x: (typeof n)[number]) => boolean) => n.filter(f).length;
    const intents = new Map<string, number>();
    for (const x of n) intents.set(x.intent.main, (intents.get(x.intent.main) ?? 0) + 1);
    lines.push(
      `map         ${m.header.centralEntity.name}: ${n.length} pages, ${count((x) => x.section === "core")} core, ${count((x) => x.section === "outer")} outer`,
      `levels      ${count((x) => x.level === "seed")} seeds under the root, ${count((x) => x.level === "node")} deeper`,
      `intent      ${[...intents.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}; ${count((x) => x.intent.mixed)} mixed`,
      `existing    ${count((x) => x.existingPage !== null)} pages already on the site, ${count((x) => !!x.conflict)} conflicts`,
      `quality     ${n
        .filter((x) => x.flags.quality && x.level !== "root")
        .map((x) => x.mainQuery)
        .join(", ")}`,
    );
    const first = n
      .filter((x) => x.priority === 1 && x.level !== "root")
      .slice(0, 8)
      .map((x) => `${x.mainQuery} (${x.section})`);
    if (first.length) lines.push(`do first    ${first.join(", ")}`);
  }
  return lines;
}

export function gateLines(g: GateResult): string[] {
  const lines = [`gate        ${g.passed ? "pass" : "FAIL"}`];
  for (const c of g.checks) {
    lines.push(`  ${c.status.padEnd(7)} ${c.kind.padEnd(8)} ${c.expect}: ${c.detail}`);
  }
  return lines;
}

export interface MapOptions {
  runsDir: string;
  clustersFile: string;
  /** Default: queries.json next to the clusters file, when it exists. */
  queriesFile?: string;
  /** Default: context.json next to the clusters file. */
  contextFile?: string;
  /** pages.json or research.json. Default: research.json next to the clusters file, when it exists. */
  pagesFile?: string;
  /** A test client's expectations.json: run the gate check on the map. */
  expectFile?: string;
  out?: string;
  provider: string;
  model: string;
  allowUnconfirmed?: boolean;
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface MapResult {
  runId: string;
  ok: boolean;
  out?: string;
  gate?: GateResult;
  lines: string[];
  timeline: string;
}

export async function mapRun(opts: MapOptions): Promise<MapResult> {
  const env = opts.env ?? process.env;
  const dir = dirname(opts.clustersFile);
  const clusters = ClusterSet.parse(readJson(opts.clustersFile));
  const contextFile = opts.contextFile ?? join(dir, "context.json");
  const context = ClientContext.parse(readJson(contextFile));
  if (!context.confirmed && !opts.allowUnconfirmed) {
    throw new Error(
      `${contextFile} isn't confirmed yet; run mycel context confirm first (or --allow-unconfirmed for a dry run)`,
    );
  }
  const queriesFile =
    opts.queriesFile ??
    (existsSync(join(dir, "queries.json")) ? join(dir, "queries.json") : undefined);
  const queries = queriesFile ? FilteredQueries.parse(readJson(queriesFile)).queries : [];
  const pagesFile =
    opts.pagesFile ??
    (existsSync(join(dir, "research.json")) ? join(dir, "research.json") : undefined);
  const pages = pagesFile ? readPages(pagesFile) : [];
  const expectations = opts.expectFile
    ? GateExpectations.parse(readJson(opts.expectFile))
    : undefined;

  const run = RunStore.create({
    runsDir: opts.runsDir,
    client: new URL(clusters.site.url).hostname,
    command: "map",
    cliVersion: CORE_VERSION,
    config: {
      clusters: opts.clustersFile,
      queries: queriesFile ?? null,
      context: contextFile,
      pages: pagesFile ?? null,
      expect: opts.expectFile ?? null,
      model: opts.model,
    },
    ...(opts.debug ? { consoleLevel: "debug" as const } : {}),
  });
  const lines: string[] = [];
  if (!context.confirmed) lines.push("note        context is not confirmed: dry run");
  if (!queriesFile) lines.push("note        no queries.json: intent falls back to the tier");
  if (!pagesFile) lines.push("note        no pages: existing pages are not linked");
  let out: string | undefined;
  let gate: GateResult | undefined;
  let failure: unknown;
  try {
    const llm = new LlmClient({ providers: providers(env), defaultProvider: opts.provider });
    const result = await runStep(run, mapStep(llm), {
      context,
      clusters,
      queries,
      pages,
      model: opts.model,
    });
    out = opts.out ?? join(dir, "topical-map.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    lines.push(...summarizeMaps(result));
    if (expectations) {
      gate = checkGate(result, expectations, {
        language: context.market.language,
        ...(queriesFile ? { queries } : {}),
      });
      lines.push(...gateLines(gate));
    }
    lines.push(`map         ${out}`);
  } catch (err) {
    failure = err;
  }
  const meta = run.finish(failure);
  if (failure) lines.push(`failed      ${(failure as Error).message}`);
  return {
    runId: run.runId,
    ok: meta.status === "ok" && (gate ? gate.passed : true),
    ...(out ? { out } : {}),
    ...(gate ? { gate } : {}),
    lines,
    timeline: formatTimeline(opts.runsDir, run.runId),
  };
}
