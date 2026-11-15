import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CORE_VERSION,
  formatTimeline,
  mapEvalStep,
  mapReviewPrompt,
  type PageRef,
  REVIEW_PERSONAS,
  type ReviewPersona,
  RunStore,
  runStep,
  type SerpBatchPort,
} from "@mycel/core";
import { MAP_METRICS, MAP_TARGETS, type MapEval, SiteMaps } from "@mycel/schema";
import { readContextWithBusiness } from "./business.ts";
import { dataforseoFromEnv } from "./dataforseo.ts";

/**
 * `mycel eval map <topical-map.json>` (issue #42, step 0). Scores a map on fixed numbers. SERPs
 * come from the cache only: paid SERP calls are always off here, so the eval costs nothing.
 */

const readJson = (path: string) => {
  if (!existsSync(path)) throw new Error(`no file at ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
};

function readPages(path: string): PageRef[] {
  const raw = readJson(path) as { pages?: unknown };
  if (!Array.isArray(raw.pages)) throw new Error(`${path} has no pages list`);
  return raw.pages as PageRef[];
}

const fmt = (v: number | null, share: boolean) =>
  v === null ? "n/a" : share ? `${Math.round(v * 100)}%` : String(v);

export function evalLines(e: MapEval): string[] {
  const c = e.counts;
  const kv = (r: Record<string, number>) =>
    Object.entries(r)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ") || "none";
  const lines = [
    `map         ${c.pages} pages (${c.core} core, ${c.outer} outer); ${c.leftOut} left out, ${c.outside} existing pages outside`,
    `actions     ${kv(c.actions)}`,
    `first plan  ${kv(c.now)}`,
    `profile     ${e.withProfile ? "business profile used" : "no business profile: offer numbers use the context's offerings"}`,
  ];
  for (const id of MAP_METRICS) {
    const m = e.metrics[id];
    const t = MAP_TARGETS[id];
    const share = id === "existingWithJob";
    const ok =
      m.value === null
        ? "    "
        : (t.max !== undefined && m.value > t.max) || (t.min !== undefined && m.value < t.min)
          ? "MISS"
          : t.max === undefined && t.min === undefined
            ? "    "
            : "ok  ";
    const of = m.of !== undefined && !share ? ` of ${m.of}` : "";
    lines.push(`  ${ok} ${fmt(m.value, share).padStart(5)}${of.padEnd(8)} ${t.label}`);
    if (m.note) lines.push(`              ${m.note}`);
    for (const x of m.examples.slice(0, 3)) lines.push(`              e.g. ${x}`);
  }
  return lines;
}

export interface EvalMapOptions {
  runsDir: string;
  mapFile: string;
  /** Default: context.json next to the map. */
  contextFile?: string;
  /** pages.json or research.json. Default: research.json next to the map, when it exists. */
  pagesFile?: string;
  out?: string;
  /** Write the two reviewer prompts (SEO expert, owner) next to the eval. */
  review?: boolean;
  serps?: boolean;
  cacheDir?: string;
  env?: NodeJS.ProcessEnv;
  debug?: boolean;
  /** Tests pass a stub instead of DataforSEO. */
  port?: SerpBatchPort;
}

export async function evalMapRun(opts: EvalMapOptions) {
  const env = opts.env ?? process.env;
  const dir = dirname(opts.mapFile);
  const maps = SiteMaps.parse(readJson(opts.mapFile));
  const contextFile = opts.contextFile ?? join(dir, "context.json");
  // The confirmed business profile (business.json next to the context) when there is one.
  const context = readContextWithBusiness(contextFile);
  const pagesFile =
    opts.pagesFile ??
    (existsSync(join(dir, "research.json")) ? join(dir, "research.json") : undefined);
  const pages = pagesFile ? readPages(pagesFile) : [];
  // Cache only: allowLiveSerp stays off, and the budget is a token amount that can't be reached.
  const port =
    opts.port ??
    dataforseoFromEnv(env, {
      cacheDir: opts.cacheDir ?? ".cache",
      budgetUsd: 0.01,
      allowLiveSerp: false,
    });
  const run = RunStore.create({
    runsDir: opts.runsDir,
    client: maps.site.replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
    command: "eval-map",
    cliVersion: CORE_VERSION,
    config: { map: opts.mapFile, context: contextFile, pages: pagesFile ?? null },
    ...(opts.debug ? { consoleLevel: "debug" as const } : {}),
  });
  const lines: string[] = [];
  if (!pagesFile) lines.push("note        no pages: the existing-page numbers are empty");
  if (!port) lines.push("note        no DataforSEO login: the overlap number is empty");
  let out: string | undefined;
  let failure: unknown;
  try {
    const result = await runStep(run, mapEvalStep(port), {
      maps,
      context,
      pages,
      serps: opts.serps !== false,
    });
    out = opts.out ?? join(dir, "map-eval.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    lines.push(...evalLines(result));
    lines.push(`eval        ${out}`);
    if (opts.review) {
      for (const persona of Object.keys(REVIEW_PERSONAS) as ReviewPersona[]) {
        const file = join(dirname(out), `map-review.${persona}.txt`);
        writeFileSync(file, `${mapReviewPrompt(persona, maps, context)}\n`);
        lines.push(`review      ${file}`);
      }
    }
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
