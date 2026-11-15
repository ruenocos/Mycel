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
  applyOwnerAnswers,
  businessProposeStep,
  CORE_VERSION,
  MycelError,
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
import { CONTEXT_FILE } from "./cluster.ts";
import { backupFile } from "./context.ts";
import { RESEARCH_FILE } from "./filter.ts";
import { command, readInput } from "./input.ts";
import { PAGES_FILE } from "./research.ts";
import type { CommandResult } from "./run-command.ts";

/**
 * `mycel business propose | apply | score | simulate` (issue #42, step 1). AI pre-fills the
 * business profile from the site and the research already on disk (no paid calls); the owner's
 * answers come from a file (written from the setup's decision cards or the onboarding), never
 * from a prompt in the terminal, so nothing hangs without a terminal and every confirmation
 * records who gave it.
 */

const PROFILE = { name: "business profile", writtenBy: "mycel business propose" };
const ANSWERS = {
  name: "owner answers file",
  writtenBy: "the setup (for a test client: mycel business simulate)",
};
const ANSWER_KEY = { name: "business answer key", writtenBy: "hand, in a fixture folder" };

const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const isUrl = (s: string) => /^https?:\/\//.test(s);

/** A profile file; a "$comment" key (answer keys carry one) is ignored. */
const ProfileFile = z
  .record(z.string(), z.unknown())
  .transform(({ $comment: _c, ...rest }) => rest)
  .pipe(BusinessProfile);

/** Reads a profile file: a proposal, a confirmed profile or (with `kind`) an answer key. */
export function readProfile(path: string, kind = PROFILE): BusinessProfile {
  return readInput(path, ProfileFile, kind);
}

/**
 * The context with its confirmed business profile attached: business.json next to the context,
 * when the context doesn't carry one itself.
 */
export function readContextWithBusiness(contextFile: string): ClientContext {
  const context = readInput(contextFile, ClientContext, CONTEXT_FILE);
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

export interface BusinessProposeResult extends CommandResult {
  runId: string;
  out?: string;
}

export async function businessPropose(
  opts: BusinessProposeOptions,
): Promise<BusinessProposeResult> {
  const env = opts.env ?? process.env;
  const context = readInput(opts.contextFile, ClientContext, CONTEXT_FILE);
  const dir = dirname(opts.contextFile);
  const researchFile =
    opts.researchFile ??
    (existsSync(join(dir, "research.json")) ? join(dir, "research.json") : undefined);
  const queries = researchFile
    ? readInput(researchFile, z.object({ queries: z.array(Query).default([]) }), RESEARCH_FILE)
        .queries
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
      return readInput(join(opts.site, "pages.json"), SitePages, PAGES_FILE).pages;
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
    lines.push(...profileLines(profile));
  } catch (err) {
    failure = err;
  }
  const meta = run.finish(failure);
  const answers = out ? join(dirname(out), "owner-answers.json") : "";
  return {
    runId: run.runId,
    ok: meta.status === "ok",
    lines,
    ...(out
      ? {
          out,
          outputs: { proposal: out },
          next: [
            {
              command: command("business apply", out, "--answers", answers),
              note: `once the owner's answers are in ${answers}: the setup writes them (a test client's owner is played by mycel business simulate)`,
            },
          ],
        }
      : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
}

export interface BusinessFileResult extends CommandResult {
  out: string;
}

/**
 * A confirmed profile is the owner's own answers (ADR 0014): a user decision, which survives
 * re-runs. Refuse to replace it unless forced.
 */
export function assertProfileReplaceable(file: string, force = false): void {
  if (force || !existsSync(file)) return;
  let why: string;
  try {
    const current = readProfile(file);
    if (!current.confirmed) return;
    why = `was confirmed by ${current.confirmed.by} on ${current.confirmed.at.slice(0, 10)}`;
  } catch {
    // Not a profile this version can read. Whatever it is, it is someone's file: keep it.
    why = "isn't a business profile this version can read";
  }
  throw new MycelError("WOULD_REPLACE", `${file} ${why}; applying answers would replace it`, {
    fix: "use --out for another file, or --force to replace it (the current file is kept as a backup)",
  });
}

/**
 * Applies the owner's answers (a file) to a proposal and writes the confirmed business.json.
 * `by` names who answered; the file's own `by` must match when both are given. A profile that
 * is already confirmed is replaced only with `force`, and then a backup is kept next to it.
 */
export function businessApply(opts: {
  proposedFile: string;
  answersFile: string;
  by?: string;
  out?: string;
  force?: boolean;
}): BusinessFileResult {
  const proposed = readProfile(opts.proposedFile);
  const answers = readInput(opts.answersFile, OwnerAnswers, ANSWERS);
  if (opts.by && opts.by !== answers.by) {
    throw new MycelError(
      "INPUT_INVALID",
      `--by "${opts.by}" doesn't match the answers file (by "${answers.by}")`,
      { fix: "pass the name the answers were given under, or leave --by out" },
    );
  }
  const profile = applyOwnerAnswers(proposed, answers);
  const out = opts.out ?? join(dirname(opts.proposedFile), "business.json");
  assertProfileReplaceable(out, opts.force);
  const backup = backupFile(out);
  writeJson(out, profile);
  return {
    ok: true,
    out,
    lines: [
      `confirmed   by ${answers.by} at ${answers.at} (answers from ${opts.answersFile})`,
      ...profileLines(profile),
      ...(backup ? [`backup      ${backup} (the profile that was there)`] : []),
    ],
    outputs: { profile: out },
    next: [{ note: "later steps read business.json when it sits next to context.json" }],
  };
}

export function businessScore(opts: { profileFile: string; keyFile: string; language: string }) {
  const s = scoreProfile(
    readProfile(opts.profileFile),
    readProfile(opts.keyFile, ANSWER_KEY),
    opts.language,
  );
  const pct = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);
  const lines = [
    `offerings   recall ${pct(s.offerings.recall)}, precision ${pct(s.offerings.precision)}`,
    ...(s.offerings.missed.length ? [`  missed    ${s.offerings.missed.join(", ")}`] : []),
    ...(s.offerings.extra.length ? [`  extra     ${s.offerings.extra.join(", ")}`] : []),
    `not offered recall ${pct(s.notOffered.recall)}${s.notOffered.missed.length ? ` (missed: ${s.notOffered.missed.join(", ")})` : ""}`,
    `places      recall ${pct(s.places.recall)}${s.places.missed.length ? ` (missed: ${s.places.missed.join(", ")})` : ""}`,
    `specific    ${pct(s.specificity)} of offering fields filled; ${s.unknownFields} unknown fields; ${s.openQuestions} open questions`,
  ];
  return { ok: true, score: s, lines, data: { score: s } } satisfies CommandResult & {
    score: typeof s;
  };
}

/** Writes the answers a test client's owner gives, played from its answer key. */
export function businessSimulate(opts: {
  proposedFile: string;
  keyFile: string;
  language: string;
  by?: string;
  out?: string;
}): BusinessFileResult {
  const answers = simulateOwner(
    readProfile(opts.proposedFile),
    readProfile(opts.keyFile, ANSWER_KEY),
    opts.language,
    ...(opts.by ? [opts.by] : []),
  );
  const out = opts.out ?? join(dirname(opts.proposedFile), "owner-answers.json");
  writeJson(out, answers);
  return {
    ok: true,
    out,
    lines: [
      `owner       ${answers.removed.length} removed, ${answers.merged.length} merged into another, ${answers.edits.length} filled in, ${answers.added.length} added, top: ${answers.top.join(", ") || "none"}`,
    ],
    outputs: { answers: out },
    next: [{ command: command("business apply", opts.proposedFile, "--answers", out) }],
  };
}
