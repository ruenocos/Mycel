import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FakeProvider,
  LlmClient,
  type LlmProvider,
  OllamaProvider,
  WordPressClient,
} from "@mycel/connectors";
import {
  applyOwnerAnswers,
  businessProposeStep,
  CORE_VERSION,
  formatTimeline,
  RunStore,
  runStep,
  scoreProfile,
  simulateOwner,
  specificity,
} from "@mycel/core";
import {
  BusinessProfile,
  ClientContext,
  OwnerAnswers,
  Query,
  type SitePage,
  SitePages,
} from "@mycel/schema";
import { z } from "zod";

/**
 * `mycel business propose | apply | score | simulate` (issue #42, step 1). AI pre-fills the
 * business profile from the site and the research already on disk (no paid calls); the owner's
 * answers come from a file (written from the setup's decision cards or the onboarding), never
 * from a prompt in the terminal, so nothing hangs without a terminal and every confirmation
 * records who gave it.
 */

const readJson = (path: string) => {
  if (!existsSync(path)) throw new Error(`no file at ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
};
const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const isUrl = (s: string) => /^https?:\/\//.test(s);

/** Reads a profile file; a "$comment" key (answer keys carry one) is ignored. */
export function readProfile(path: string): BusinessProfile {
  const { $comment: _c, ...rest } = readJson(path) as Record<string, unknown>;
  return BusinessProfile.parse(rest);
}

/**
 * The context with its confirmed business profile attached: business.json next to the context,
 * when the context doesn't carry one itself.
 */
export function readContextWithBusiness(contextFile: string): ClientContext {
  const context = ClientContext.parse(readJson(contextFile));
  const file = join(dirname(contextFile), "business.json");
  if (context.business || !existsSync(file)) return context;
  return { ...context, business: readProfile(file) };
}

/** The fake model proposes one offering per service or category page, with that page as proof. */
function providers(env: NodeJS.ProcessEnv): LlmProvider[] {
  const fake = new FakeProvider([], (req) => {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";
    const offers = [...user.matchAll(/^- page:(\S+) \| (service|category) \| [^|]+\| (.+)$/gm)].map(
      (m) => ({
        name: (m[3] ?? "").trim(),
        kind: m[2] === "service" ? "service" : "product_category",
        page: m[1],
        evidence: [`page:${m[1]}`],
      }),
    );
    return JSON.stringify({
      offerings: offers.length ? offers : [{ name: "(fake)", kind: "service", evidence: [] }],
    });
  });
  const ollama = new OllamaProvider({
    host: env.OLLAMA_HOST ?? "https://ollama.com",
    ...(env.OLLAMA_API_KEY ? { apiKey: env.OLLAMA_API_KEY } : {}),
    timeoutMs: 300_000,
  });
  return [fake, ollama];
}

export function profileLines(p: BusinessProfile): string[] {
  const named = new Set(
    p.places.locations.flatMap((l) => [l.name, l.city]).map((s) => s.toLowerCase()),
  );
  const serves = p.places.serves.filter((s) => !named.has(s.toLowerCase()));
  const lines = [
    `offerings   ${p.offerings.length}: ${p.offerings.map((o) => `${o.name}${o.value === "top" ? " (top)" : ""}`).join(", ")}`,
    `specific    ${Math.round((p.offerings.reduce((s, o) => s + specificity(o), 0) / p.offerings.length) * 100)}% of offering fields filled; ${p.offerings.reduce((s, o) => s + o.unknown.length, 0)} unknown fields to ask`,
    `not offered ${p.notOffered.map((n) => n.name).join(", ") || "none found"}`,
    `places      ${[...p.places.locations.map((l) => `${l.name} (${l.city})`), ...serves].join(", ") || (p.places.nationwide ? "nationwide" : "none found")}`,
    `facts       ${p.facts.length} facts, ${p.differentiators.length} differentiators`,
  ];
  if (p.openQuestions.length) lines.push(`ask         ${p.openQuestions.join(" ")}`);
  return lines;
}

export interface BusinessProposeOptions {
  runsDir: string;
  contextFile: string;
  /** A site URL (read over the WordPress REST API, cached) or a folder with pages.json. */
  site: string;
  /** research.json: GSC, ranked and competitor searches. Default: next to the context. */
  researchFile?: string;
  out?: string;
  provider: string;
  model: string;
  cacheDir?: string;
  env?: NodeJS.ProcessEnv;
  debug?: boolean;
}

export async function businessPropose(opts: BusinessProposeOptions) {
  const env = opts.env ?? process.env;
  const context = ClientContext.parse(readJson(opts.contextFile));
  const dir = dirname(opts.contextFile);
  const researchFile =
    opts.researchFile ??
    (existsSync(join(dir, "research.json")) ? join(dir, "research.json") : undefined);
  const queries = researchFile
    ? z.array(Query).parse((readJson(researchFile) as { queries?: unknown }).queries ?? [])
    : [];
  const run = RunStore.create({
    runsDir: opts.runsDir,
    client: new URL(context.site.url).hostname,
    command: "business propose",
    cliVersion: CORE_VERSION,
    config: {
      context: opts.contextFile,
      site: opts.site,
      research: researchFile ?? null,
      model: opts.model,
    },
    ...(opts.debug ? { consoleLevel: "debug" as const } : {}),
  });
  const lines: string[] = [];
  if (!researchFile) lines.push("note        no research.json: search evidence is empty");
  let out: string | undefined;
  let failure: unknown;
  try {
    const pages: SitePage[] = await run.step("business-sources", async (ctx) => {
      if (isUrl(opts.site)) {
        const wp = new WordPressClient({
          baseUrl: new URL(opts.site).origin,
          cacheDir: join(opts.cacheDir ?? ".cache", "wordpress"),
        });
        return (await wp.readSite(ctx)).pages;
      }
      return SitePages.parse(readJson(join(opts.site, "pages.json"))).pages;
    });
    lines.push(`evidence    ${pages.length} pages, ${queries.length} searches`);
    const llm = new LlmClient({ providers: providers(env), defaultProvider: opts.provider });
    const profile = await runStep(run, businessProposeStep(llm), {
      context,
      pages,
      queries,
      model: opts.model,
    });
    out = opts.out ?? join(dir, "business.proposed.json");
    writeJson(out, profile);
    lines.push(...profileLines(profile), `proposal    ${out}`);
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
 * Applies the owner's answers (a file) to a proposal and writes the confirmed business.json.
 * `by` names who answered; the file's own `by` must match when both are given.
 */
export function businessApply(opts: {
  proposedFile: string;
  answersFile: string;
  by?: string;
  out?: string;
}) {
  const proposed = readProfile(opts.proposedFile);
  const answers = OwnerAnswers.parse(readJson(opts.answersFile));
  if (opts.by && opts.by !== answers.by) {
    throw new Error(`--by "${opts.by}" doesn't match the answers file (by "${answers.by}")`);
  }
  const profile = applyOwnerAnswers(proposed, answers);
  const out = opts.out ?? join(dirname(opts.proposedFile), "business.json");
  writeJson(out, profile);
  return {
    out,
    lines: [
      `confirmed   by ${answers.by} at ${answers.at} (answers from ${opts.answersFile})`,
      ...profileLines(profile),
      `profile     ${out}`,
    ],
  };
}

export function businessScore(opts: { profileFile: string; keyFile: string; language: string }) {
  const s = scoreProfile(readProfile(opts.profileFile), readProfile(opts.keyFile), opts.language);
  const pct = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);
  const lines = [
    `offerings   recall ${pct(s.offerings.recall)}, precision ${pct(s.offerings.precision)}`,
    ...(s.offerings.missed.length ? [`  missed    ${s.offerings.missed.join(", ")}`] : []),
    ...(s.offerings.extra.length ? [`  extra     ${s.offerings.extra.join(", ")}`] : []),
    `not offered recall ${pct(s.notOffered.recall)}${s.notOffered.missed.length ? ` (missed: ${s.notOffered.missed.join(", ")})` : ""}`,
    `places      recall ${pct(s.places.recall)}${s.places.missed.length ? ` (missed: ${s.places.missed.join(", ")})` : ""}`,
    `specific    ${pct(s.specificity)} of offering fields filled; ${s.unknownFields} unknown fields; ${s.openQuestions} open questions`,
  ];
  return { score: s, lines };
}

/** Writes the answers a test client's owner gives, played from its answer key. */
export function businessSimulate(opts: {
  proposedFile: string;
  keyFile: string;
  language: string;
  by?: string;
  out?: string;
}) {
  const answers = simulateOwner(
    readProfile(opts.proposedFile),
    readProfile(opts.keyFile),
    opts.language,
    ...(opts.by ? [opts.by] : []),
  );
  const out = opts.out ?? join(dirname(opts.proposedFile), "owner-answers.json");
  writeJson(out, answers);
  return {
    out,
    lines: [
      `owner       ${answers.removed.length} removed, ${answers.merged.length} merged into another, ${answers.edits.length} filled in, ${answers.added.length} added, top: ${answers.top.join(", ") || "none"}`,
      `answers     ${out}`,
    ],
  };
}
