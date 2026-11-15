import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FakeProvider,
  LlmClient,
  type LlmProvider,
  OllamaProvider,
  WordPressClient,
} from "@mycel/connectors";
import {
  CORE_VERSION,
  checkGate,
  type GateResult,
  MycelError,
  mapShape,
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
  MenuGroup,
  type SiteMaps,
  SiteSection,
} from "@mycel/schema";
import { z } from "zod";
import { readProfile } from "./business.ts";
import { CONTEXT_FILE, QUERIES_FILE } from "./cluster.ts";
import { dataforseoFromEnv } from "./dataforseo.ts";
import { assertConfirmed, readInput } from "./input.ts";
import type { CommandResult } from "./run-command.ts";

/**
 * `mycel map <clusters.json>` (issue #19, Koray steps 11-14 and 20). Thin shell around core's map
 * step: data builds the tree, the model names each page and places pages whose words don't nest.
 */

/**
 * The fake model labels every page and leaves hubs at the root; asked to link existing pages,
 * it picks each page's first likely map page, else "none". It groups nothing and leaves
 * conflicts to the rule-based advice.
 */
function providers(env: NodeJS.ProcessEnv): LlmProvider[] {
  const fake = new FakeProvider([], (req) => {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";
    if (user.includes("\nPages under ")) return JSON.stringify({ groups: [] });
    if (user.includes("\nConflicts:\n")) return JSON.stringify({ results: [] });
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

const CLUSTERS_FILE = { name: "clusters file", writtenBy: "mycel cluster" };
const PAGES_SOURCE = { name: "pages or research file", writtenBy: "mycel research" };
const EXPECTATIONS = { name: "expectations file", writtenBy: "hand, in a fixture folder" };

interface SiteRead {
  pages: PageRef[];
  sections: SiteSection[];
  menu: MenuGroup[];
}

/**
 * Pages from a pages.json (fixture or WordPress read) or a research.json, with the site's
 * sections and menu groups when the file has them (issue #51).
 */
function readPages(path: string): SiteRead {
  const read = readInput(
    path,
    z.object({
      pages: z.array(z.unknown()),
      sections: z.array(SiteSection).default([]),
      menu: z.array(MenuGroup).default([]),
    }),
    PAGES_SOURCE,
  );
  return { pages: read.pages as PageRef[], sections: read.sections, menu: read.menu };
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

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
      shapeLine(n),
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
    const backlog = m.leftOut.filter((x) => x.reason === "over_budget").length;
    lines.push(
      `budget      ${count((x) => x.action === "create")} new pages, ${count((x) => x.action === "improve" || x.action === "resolve")} to fix; ${backlog} ideas in the backlog`,
    );
    const first = n
      .filter((x) => x.wave === "now")
      .sort((a, b) => (a.planStep ?? 0) - (b.planStep ?? 0))
      .slice(0, 10)
      .map((x) => `${x.planStep}. ${x.action} ${x.name ?? x.mainQuery}`);
    if (first.length) lines.push(`first plan  ${first.join(", ")}`);
  }
  if (d.inventory?.length) {
    const jobs = new Map<string, number>();
    for (const e of d.inventory) jobs.set(e.job, (jobs.get(e.job) ?? 0) + 1);
    lines.push(
      `page jobs   ${[...jobs].map(([k, v]) => `${k} ${v}`).join(", ")} (of ${d.inventory.length} existing pages)`,
    );
  }
  return lines;
}

function shapeLine(nodes: SiteMaps["maps"][number]["nodes"]): string {
  const s = mapShape(nodes);
  const pct = s.hubs ? Math.round((s.childless / s.hubs) * 100) : 0;
  return `shape       ${s.siteHubs} site hubs (${s.siteHubsKept} kept), ${s.childless} of ${s.hubs} seeds without children (${pct}%), widest ${s.widest ? `"${s.widest.mainQuery}" (${s.widest.children})` : "none"}`;
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
  /** The confirmed business profile. Default: business.json next to the context, when it exists. */
  businessFile?: string;
  /** DataforSEO cache folder for the one-page-per-intent check (cache only, no paid calls). */
  cacheDir?: string;
  /** A test client's expectations.json: run the gate check on the map. */
  expectFile?: string;
  out?: string;
  provider: string;
  model: string;
  allowUnconfirmed?: boolean;
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface MapResult extends CommandResult {
  runId: string;
  out?: string;
  gate?: GateResult;
}

export async function mapRun(opts: MapOptions): Promise<MapResult> {
  const env = opts.env ?? process.env;
  const dir = dirname(opts.clustersFile);
  const clusters = readInput(opts.clustersFile, ClusterSet, CLUSTERS_FILE);
  const contextFile = opts.contextFile ?? join(dir, "context.json");
  const read = readInput(contextFile, ClientContext, CONTEXT_FILE);
  assertConfirmed(read, contextFile, opts.allowUnconfirmed);
  const businessFile =
    opts.businessFile ??
    (existsSync(join(dirname(contextFile), "business.json"))
      ? join(dirname(contextFile), "business.json")
      : undefined);
  const business = read.business ?? (businessFile ? readProfile(businessFile) : undefined);
  const context: ClientContext = business ? { ...read, business } : read;
  const queriesFile =
    opts.queriesFile ??
    (existsSync(join(dir, "queries.json")) ? join(dir, "queries.json") : undefined);
  const queries = queriesFile ? readInput(queriesFile, FilteredQueries, QUERIES_FILE).queries : [];
  const pagesFile =
    opts.pagesFile ??
    (existsSync(join(dir, "research.json")) ? join(dir, "research.json") : undefined);
  // A site URL is read live over the public WordPress API (free, cached) inside the run.
  const siteRead: SiteRead =
    pagesFile && !isUrl(pagesFile) ? readPages(pagesFile) : { pages: [], sections: [], menu: [] };
  const expectations = opts.expectFile
    ? readInput(opts.expectFile, GateExpectations, EXPECTATIONS)
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
      business: business ? (businessFile ?? "in context") : null,
      model: opts.model,
    },
    ...(opts.debug ? { consoleLevel: "debug" as const } : {}),
  });
  const lines: string[] = [];
  if (!context.confirmed) lines.push("note        context is not confirmed: trial run");
  if (!queriesFile) lines.push("note        no queries.json: intent falls back to the tier");
  if (!pagesFile) lines.push("note        no pages: existing pages are not linked");
  if (!business) lines.push("note        no business.json: map without the business profile");
  else if (!business.confirmed) lines.push("note        business profile is not confirmed");
  let out: string | undefined;
  let gate: GateResult | undefined;
  let failure: unknown;
  try {
    const llm = new LlmClient({ providers: providers(env), defaultProvider: opts.provider });
    // Cache only: the one-page-per-intent check reuses SERPs clustering already paid for.
    const serps = business
      ? dataforseoFromEnv(env, {
          cacheDir: opts.cacheDir ?? ".cache",
          budgetUsd: 0.01,
          allowLiveSerp: false,
        })
      : undefined;
    const site =
      pagesFile && isUrl(pagesFile)
        ? await run.step("site-sections", async (ctx) => {
            const wp = new WordPressClient({
              baseUrl: new URL(pagesFile).origin,
              cacheDir: join(opts.cacheDir ?? ".cache", "wordpress"),
            });
            return wp.readSite(ctx);
          })
        : siteRead;
    lines.push(
      `sections    ${site.sections.length ? site.sections.map((x) => x.name).join(", ") : "from URL folders"}`,
    );
    const result = await runStep(run, mapStep(llm, serps), {
      context,
      clusters,
      queries,
      pages: site.pages,
      sections: site.sections,
      menu: site.menu,
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
  } catch (err) {
    failure = err;
  }
  const meta = run.finish(failure);
  // The run can be fine while the map misses its gate: that is a missed mark, not a crash.
  if (failure === undefined && gate && !gate.passed) {
    const missed = gate.checks.filter((c) => c.status === "fail").length;
    failure = new MycelError(
      "BELOW_PASS_MARK",
      `the map misses ${missed} of ${gate.checks.length} gate checks`,
      { fix: "the gate lines above say which; the map file is written so it can be inspected" },
    );
  }
  return {
    runId: run.runId,
    ok: meta.status === "ok" && (gate ? gate.passed : true),
    lines,
    ...(out
      ? {
          out,
          outputs: { map: out },
          next: [{ note: `review ${out}: the map is the last step of the pipeline for now` }],
        }
      : {}),
    ...(gate ? { gate } : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
}
