import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FakeProvider,
  LlmClient,
  type LlmProvider,
  type ModelPricing,
  OllamaProvider,
} from "@mycel/connectors";
import {
  BRIEFS_DIR,
  type BriefData,
  type BriefInput,
  briefFileName,
  briefSearches,
  briefSources,
  briefStep,
  CORE_VERSION,
  estimateBriefTokens,
  findPage,
  firstPlanPages,
  MycelError,
  RunStore,
  runStep,
} from "@mycel/core";
import {
  Brief,
  type BriefEvidence,
  ClientContext,
  FilteredQueries,
  ResearchDataset,
  type SerpSnapshot,
  SignalSet,
  SiteMaps,
} from "@mycel/schema";
import { readProfile } from "./business.ts";
import { CONTEXT_FILE, QUERIES_FILE } from "./cluster.ts";
import { DRY_RUN, dataforseoFromEnv, runBudget } from "./dataforseo.ts";
import { RESEARCH_FILE } from "./filter.ts";
import { assertConfirmed, command, readInput } from "./input.ts";
import type { CommandResult } from "./run-command.ts";

/**
 * `mycel brief <topical-map.json>` (ADR 0020): a brief per map page, from the research the map
 * stands on and the confirmed business profile. Thin shell around core's brief step: one model
 * call per page, under a cost cap, and `--dry-run` counts it first.
 *
 * Results pages come from research.json and from the DataforSEO cache only: a brief never buys
 * a SERP.
 */

const MAP_FILE = { name: "topical map", writtenBy: "mycel map" };
const SIGNALS_FILE = { name: "signals file", writtenBy: "mycel signals" };

/** The fake model writes a small brief that uses the first facts it is shown. */
function providers(env: NodeJS.ProcessEnv): LlmProvider[] {
  const fake = new FakeProvider([], (req) => {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";
    const ids = [...user.matchAll(/^(e\d+): /gm)].map((m) => m[1]).slice(0, 2);
    return JSON.stringify({
      coreMessage: "fake message",
      reader: { searchesFor: "fake search", feels: "fake feeling", doesNext: "fake next step" },
      difference: "fake difference",
      outline: [
        { level: "h1", heading: "fake title", purpose: "fake intro", form: "prose", words: 1 },
        {
          level: "h2",
          heading: "fake part",
          purpose: "fake part",
          form: "bullets",
          evidence: ids,
          words: 3,
        },
      ],
      avoid: ["fake angle"],
      questions: [0],
      links: [],
      cta: "fake action",
    });
  });
  const ollama = new OllamaProvider({
    host: env.OLLAMA_HOST ?? "https://ollama.com",
    ...(env.OLLAMA_API_KEY ? { apiKey: env.OLLAMA_API_KEY } : {}),
    timeoutMs: 300_000,
  });
  return [fake, ollama];
}

/**
 * The model's price from LLM_PRICE_USD_PER_MTOK ("input/output" dollars per million tokens),
 * for a metered provider. Unset: no price, which is right for Ollama Cloud (a subscription).
 */
export function llmPricing(
  env: NodeJS.ProcessEnv,
  provider: string,
  model: string,
): Record<string, ModelPricing> {
  const raw = env.LLM_PRICE_USD_PER_MTOK?.trim();
  if (!raw) return {};
  const [i, o] = raw.split("/").map((x) => Number(x.trim()));
  if (!(Number.isFinite(i) && Number.isFinite(o) && (i as number) >= 0 && (o as number) >= 0)) {
    throw new MycelError(
      "USAGE",
      `LLM_PRICE_USD_PER_MTOK must be "input/output" dollars per million tokens, got "${raw}"`,
      { fix: "correct it in .env, e.g. LLM_PRICE_USD_PER_MTOK=0.3/1.2, or leave it empty" },
    );
  }
  return { [`${provider}/${model}`]: { inputPerMTok: i as number, outputPerMTok: o as number } };
}

const usd = (n: number) => `$${n.toFixed(4)}`;

export interface BriefOptions {
  runsDir: string;
  mapFile: string;
  /** Map pages by id, URL or main search. */
  pages?: string[];
  /** The first n pages of the first plan. */
  plan?: number;
  /** Default: context.json next to the map. */
  contextFile?: string;
  /** Default: research.json, queries.json and signals.json next to the map, when there. */
  researchFile?: string;
  queriesFile?: string;
  signalsFile?: string;
  /** Default: briefs/ next to the map. */
  outDir?: string;
  /** LLM cost cap for the run, in dollars. */
  budgetUsd?: number;
  /** Replace a brief whose facts a person already checked. */
  force?: boolean;
  provider: string;
  model: string;
  dryRun?: boolean;
  cacheDir?: string;
  allowUnconfirmed?: boolean;
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: string;
}

/** The brief that is there now, when it can be read: a person's checks live in it. */
function previousEvidence(file: string): BriefEvidence[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = Brief.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data.evidence : [];
  } catch {
    // Not JSON: nothing to carry over, and nothing a person checked in it can be read either.
    return [];
  }
}

const optional = (path: string) => (existsSync(path) ? path : undefined);

export async function briefRun(opts: BriefOptions): Promise<CommandResult> {
  const env = opts.env ?? process.env;
  const budgetUsd = runBudget(opts.budgetUsd, 0.25);
  if (opts.plan !== undefined && !(Number.isInteger(opts.plan) && opts.plan > 0)) {
    throw new MycelError("USAGE", `--plan must be a whole number of pages, got ${opts.plan}`);
  }
  const dir = dirname(opts.mapFile);
  const maps = readInput(opts.mapFile, SiteMaps, MAP_FILE);
  const contextFile = opts.contextFile ?? join(dir, "context.json");
  const read = readInput(contextFile, ClientContext, CONTEXT_FILE);
  assertConfirmed(read, contextFile, opts.allowUnconfirmed);
  const businessFile = join(dirname(contextFile), "business.json");
  const business =
    read.business ?? (existsSync(businessFile) ? readProfile(businessFile) : undefined);
  const context: ClientContext = business ? { ...read, business } : read;
  const researchFile = opts.researchFile ?? optional(join(dir, "research.json"));
  const queriesFile = opts.queriesFile ?? optional(join(dir, "queries.json"));
  const signalsFile = opts.signalsFile ?? optional(join(dir, "signals.json"));
  const research = researchFile
    ? readInput(researchFile, ResearchDataset, RESEARCH_FILE)
    : undefined;
  const queries = queriesFile ? readInput(queriesFile, FilteredQueries, QUERIES_FILE).queries : [];
  const signals = signalsFile ? readInput(signalsFile, SignalSet, SIGNALS_FILE) : undefined;

  // Which pages: named ones, then the first plan's. Asking for none is a mistake, not "all".
  const planned = firstPlanPages(maps, 3).map((n) => n.id);
  const pageFix = `pass --page with a page id, URL or main search from the map, or --plan <n> for the first plan's pages${planned.length ? ` (it starts with ${planned.join(", ")})` : ""}`;
  const ids: string[] = [];
  for (const ref of opts.pages ?? []) {
    const found = findPage(maps, ref);
    if (!found)
      throw new MycelError("USAGE", `no page "${ref}" in ${opts.mapFile}`, { fix: pageFix });
    ids.push(found.node.id);
  }
  if (opts.plan) ids.push(...firstPlanPages(maps, opts.plan).map((n) => n.id));
  const pages = [...new Set(ids)];
  if (!pages.length) {
    throw new MycelError(
      "USAGE",
      opts.plan ? `${opts.mapFile} has no first plan` : "no page asked for",
      { fix: pageFix },
    );
  }

  const outDir = opts.outDir ?? join(dir, BRIEFS_DIR);
  const now = opts.now ?? new Date().toISOString();
  const pricing = llmPricing(env, opts.provider, opts.model);
  const price = pricing[`${opts.provider}/${opts.model}`];
  const lines: string[] = [];
  if (!context.confirmed) lines.push("note        context is not confirmed: trial run");
  if (!business) lines.push("note        no business.json: briefs without facts to use");
  else if (!business.confirmed) lines.push("note        business profile is not confirmed");
  if (!researchFile) lines.push("note        no research.json: results pages from the cache only");

  /** The inputs, with the cached results pages when `serps` has them. */
  const inputs = (serps: SerpSnapshot[]) => {
    const data: BriefData = {
      context,
      maps,
      serps,
      queries,
      ...(signals ? { signals } : {}),
    };
    return pages.map((id) => {
      const s = briefSources(data, id);
      const file = join(outDir, briefFileName(id));
      const input: BriefInput = {
        ...s,
        context,
        previous: previousEvidence(file),
        now,
        model: opts.model,
      };
      return { id, file, input };
    });
  };
  const fromResearch = research?.serps ?? [];

  // A person's checks are their work: a brief with checked facts is only replaced when asked.
  const checked = inputs(fromResearch).filter((x) =>
    x.input.previous.some((e) => e.check.state === "checked"),
  );
  if (checked.length && !opts.force && !opts.dryRun) {
    throw new MycelError(
      "WOULD_REPLACE",
      `${checked.map((x) => x.file).join(", ")} has facts a person checked; a new brief would replace it`,
      {
        fix: "use --out for another folder, or --force to replace it (checks on facts that stay carry over)",
      },
    );
  }

  if (opts.dryRun) {
    const counted = inputs(fromResearch).map((x) => ({
      nodeId: x.id,
      ...estimateBriefTokens(x.input),
    }));
    const tokensIn = counted.reduce((n, c) => n + c.input, 0);
    const tokensOut = counted.reduce((n, c) => n + c.output, 0);
    const estimateUsd = price
      ? (tokensIn * price.inputPerMTok + tokensOut * price.outputPerMTok) / 1e6
      : 0;
    const out = [DRY_RUN, ...lines];
    for (const c of counted) {
      out.push(
        `page        ${c.nodeId}: about ${c.input} tokens in, ${c.output} out (one model call)`,
      );
    }
    out.push(
      price
        ? `cost        about ${usd(estimateUsd)} for ${counted.length} brief(s) at $${price.inputPerMTok}/$${price.outputPerMTok} per million tokens; budget $${budgetUsd}`
        : `cost        $0.0000 per call: ${opts.provider} has no price set (Ollama Cloud is a subscription). LLM_PRICE_USD_PER_MTOK prices a metered model`,
      "serps       research.json and the DataforSEO cache only: nothing is bought",
    );
    return {
      ok: true,
      lines: out,
      data: { pages: counted, tokensIn, tokensOut, estimateUsd, budgetUsd },
      next: [
        {
          note: `the same command without --dry-run writes ${counted.length} brief(s) to ${outDir}`,
        },
      ],
    };
  }

  const run = RunStore.create({
    runsDir: opts.runsDir,
    client: new URL(context.site.url).hostname,
    command: "brief",
    cliVersion: CORE_VERSION,
    config: {
      map: opts.mapFile,
      context: contextFile,
      research: researchFile ?? null,
      queries: queriesFile ?? null,
      signals: signalsFile ?? null,
      pages,
      budgetUsd,
      model: opts.model,
    },
    ...(opts.debug ? { consoleLevel: "debug" as const } : {}),
  });
  const llm = new LlmClient({
    providers: providers(env),
    defaultProvider: opts.provider,
    pricing,
    budgetUsd,
  });
  const outputs: Record<string, string> = {};
  let failure: unknown;
  try {
    // Cache only (allowLiveSerp off, a cent of budget): SERPs clustering already paid for.
    const dfs = dataforseoFromEnv(env, {
      cacheDir: opts.cacheDir ?? ".cache",
      budgetUsd: 0.01,
      allowLiveSerp: false,
    });
    const serps = [...fromResearch];
    if (dfs) {
      const have = new Set(serps.map((s) => s.keyword));
      const wanted = [
        ...new Set(
          pages.flatMap((id) => {
            const n = findPage(maps, id)?.node;
            return n ? briefSearches(n) : [];
          }),
        ),
      ].filter((q) => !have.has(q));
      if (wanted.length) {
        const cached = await run.step("brief-serps", (ctx) =>
          dfs.serpOrganicBatch(wanted, context.market, ctx),
        );
        serps.push(...cached.serps.values());
        lines.push(
          `serps       ${cached.serps.size} results pages from the cache, ${cached.blocked.length} not cached (not bought)`,
        );
      }
    }
    mkdirSync(outDir, { recursive: true });
    for (const { id, file, input } of inputs(serps)) {
      const brief = await runStep(run, briefStep(llm, id), input);
      writeFileSync(file, `${JSON.stringify(brief, null, 2)}\n`);
      outputs[`brief:${id}`] = file;
      const words = brief.outline.reduce((n, h) => n + h.words, 0);
      lines.push(
        `brief       ${id}: ${brief.targets.headings} headings, ${brief.evidence.length} facts, ${brief.questions.length} questions, ${brief.links.length} links, ${words} words`,
      );
      for (const w of brief.warnings) lines.push(`note        ${id}: ${w}`);
    }
    lines.push(
      `cost        ${usd(llm.spentUsd)} LLM (budget $${budgetUsd}${price ? "" : "; no price set: a subscription"})`,
    );
  } catch (err) {
    failure = err;
  }
  const meta = run.finish(failure);
  const written = Object.values(outputs);
  return {
    runId: run.runId,
    ok: meta.status === "ok",
    lines,
    outputs,
    data: { pages, written: written.length },
    ...(written.length
      ? {
          next: [
            {
              note: `review ${written.length === 1 ? written[0] : outDir}: a person checks each fact before the text is written`,
            },
          ],
        }
      : {}),
    ...(failure !== undefined ? { failure } : {}),
    ...(failure !== undefined && written.length < pages.length
      ? {
          retry: command(
            "brief",
            opts.mapFile,
            ...pages.filter((p) => !outputs[`brief:${p}`]).flatMap((p) => ["--page", p]),
          ),
        }
      : {}),
  };
}
