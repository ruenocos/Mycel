import { createInterface } from "node:readline/promises";
import { CORE_VERSION, formatTimeline, type LogLevel, listRuns, resolveRunId } from "@mycel/core";
import { Command, Option } from "commander";
import { businessApply, businessPropose, businessScore, businessSimulate } from "./business.ts";
import { clusterRun } from "./cluster.ts";
import { contextConfirm, contextPropose } from "./context.ts";
import { evalMapRun } from "./eval-map.ts";
import { writingRun, writingScore } from "./eval-writing.ts";
import { DEFAULT_MIN_ACCURACY, filterEval, filterRun } from "./filter.ts";
import { gscCheck } from "./gsc-check.ts";
import { llmPing } from "./llm-ping.ts";
import { mapRun } from "./map.ts";
import { research } from "./research.ts";

const usd = (n: number) => `$${n.toFixed(4)}`;

export function buildProgram(out: (s: string) => void = (s) => console.log(s)): Command {
  const program = new Command()
    .name("mycel")
    .description("Build a data-driven topical map. A human approves everything.")
    .version(CORE_VERSION)
    .option("--runs-dir <dir>", "where runs are stored", "runs");

  program
    .command("logs")
    .description("Show a readable timeline of a run, or list recent runs")
    .argument("[run]", 'run id, unique prefix, or "latest"')
    .addOption(
      new Option("--level <level>", "minimum level to show")
        .choices(["debug", "info", "warn", "error"])
        .default("info"),
    )
    .action((run: string | undefined, opts: { level: LogLevel }) => {
      const runsDir = program.opts<{ runsDir: string }>().runsDir;
      if (!run) {
        const runs = listRuns(runsDir).slice(0, 15);
        if (runs.length === 0) return out(`No runs in ${runsDir}.`);
        for (const r of runs) {
          out(`${r.runId}  ${r.status.padEnd(7)}  ${r.client}  ${r.command}  ${usd(r.costUsd)}`);
        }
        return;
      }
      out(formatTimeline(runsDir, resolveRunId(runsDir, run), { minLevel: opts.level }));
    });

  const llm = program.command("llm").description("LLM provider tools");
  llm
    .command("ping")
    .description("One logged LLM call, to check provider, key and logging")
    .addOption(
      new Option("--provider <name>", "LLM provider").choices(["ollama", "fake"]).default("ollama"),
    )
    .option("--model <model>", "model name", "deepseek-v4.1-flash")
    .option("--debug", "mirror logs to the console")
    .action(async (opts: { provider: string; model: string; debug?: boolean }) => {
      const runsDir = program.opts<{ runsDir: string }>().runsDir;
      const { timeline } = await llmPing({ runsDir, ...opts });
      out(timeline);
    });

  const context = program
    .command("context")
    .description("Steps 1-6: propose the client context, then confirm it by hand");
  context
    .command("propose")
    .description(
      "Read the site and its search data and propose answers to the nine client questions",
    )
    .argument("<site>", "site URL (WordPress) or a fixture folder with pages.json")
    .option(
      "--market <market>",
      'country / language / city, e.g. "NL / nl / Utrecht" (default: from the site)',
    )
    .option("--out <file>", "where to write the proposal (default: clients/<host>/context.json)")
    .addOption(
      new Option("--provider <name>", "LLM provider").choices(["ollama", "fake"]).default("ollama"),
    )
    .option("--model <model>", "model name", "deepseek-v4.1-flash")
    .option("--no-gsc", "don't use Search Console")
    .option("--no-dataforseo", "don't use DataforSEO")
    .option("--budget <usd>", "DataforSEO budget for this run", "0.5")
    .option(
      "--force",
      "replace a context that was already confirmed or reviewed (a backup is kept next to it)",
    )
    .option("--debug", "mirror logs to the console")
    .action(
      async (
        site: string,
        opts: {
          market?: string;
          out?: string;
          provider: string;
          model: string;
          gsc: boolean;
          dataforseo: boolean;
          budget: string;
          force?: boolean;
          debug?: boolean;
        },
      ) => {
        const runsDir = program.opts<{ runsDir: string }>().runsDir;
        let res: Awaited<ReturnType<typeof contextPropose>>;
        try {
          res = await contextPropose({
            runsDir,
            site,
            provider: opts.provider,
            model: opts.model,
            gsc: opts.gsc,
            dataforseo: opts.dataforseo,
            budgetUsd: Number(opts.budget),
            ...(opts.market ? { market: opts.market } : {}),
            ...(opts.out ? { out: opts.out } : {}),
            ...(opts.force ? { force: true } : {}),
            ...(opts.debug ? { debug: true } : {}),
          });
        } catch (err) {
          // Raised before a run exists (a bad --budget, a confirmed context in the way).
          out(`failed      ${(err as Error).message}`);
          process.exitCode = 1;
          return;
        }
        for (const l of res.lines) out(l);
        out("");
        out(res.timeline);
        if (!res.ok) process.exitCode = 1;
      },
    );
  context
    .command("confirm")
    .description("Go through a proposed context in the terminal: keep or edit every answer")
    .argument("<file>", "context.json written by mycel context propose")
    .option("--by <name>", "who confirms (default: your OS user name)")
    .action(async (file: string, opts: { by?: string }) => {
      const by = opts.by ?? process.env.USERNAME ?? process.env.USER ?? "unknown";
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        await contextConfirm(file, by, { print: out, ask: (p) => rl.question(p) });
      } finally {
        rl.close();
      }
    });

  const business = program
    .command("business")
    .description(
      "The business profile (issue #42): AI pre-fills it from the site and research, the owner confirms from an answers file",
    );
  business
    .command("propose")
    .description("Pre-fill the business profile from the site and research.json (no paid calls)")
    .argument("<context>", "the client's context.json")
    .requiredOption(
      "--site <site>",
      "site URL (WordPress REST API, cached) or a folder with pages.json",
    )
    .option(
      "--research <file>",
      "research.json with GSC, ranked and competitor searches (default: next to the context)",
    )
    .option(
      "--out <file>",
      "where to write it (default: business.proposed.json next to the context)",
    )
    .addOption(
      new Option("--provider <name>", "LLM provider").choices(["ollama", "fake"]).default("ollama"),
    )
    .option("--model <model>", "model name", "deepseek-v4.1-flash")
    .option("--debug", "mirror logs to the console")
    .action(
      async (
        contextFile: string,
        opts: {
          site: string;
          research?: string;
          out?: string;
          provider: string;
          model: string;
          debug?: boolean;
        },
      ) => {
        const runsDir = program.opts<{ runsDir: string }>().runsDir;
        let res: Awaited<ReturnType<typeof businessPropose>>;
        try {
          res = await businessPropose({
            runsDir,
            contextFile,
            site: opts.site,
            provider: opts.provider,
            model: opts.model,
            ...(opts.research ? { researchFile: opts.research } : {}),
            ...(opts.out ? { out: opts.out } : {}),
            ...(opts.debug ? { debug: true } : {}),
          });
        } catch (err) {
          out(`failed      ${(err as Error).message}`);
          process.exitCode = 1;
          return;
        }
        for (const l of res.lines) out(l);
        out("");
        out(res.timeline);
        if (!res.ok) process.exitCode = 1;
      },
    );
  business
    .command("apply")
    .description(
      "Confirm the profile with the owner's answers from a file (written from the setup); never asks in the terminal",
    )
    .argument("<proposed>", "business.proposed.json")
    .requiredOption("--answers <file>", "the owner's answers (OwnerAnswers JSON)")
    .option("--by <name>", "who answered; must match the file's by")
    .option("--out <file>", "where to write it (default: business.json next to the proposal)")
    .action((proposedFile: string, opts: { answers: string; by?: string; out?: string }) => {
      try {
        const res = businessApply({
          proposedFile,
          answersFile: opts.answers,
          ...(opts.by ? { by: opts.by } : {}),
          ...(opts.out ? { out: opts.out } : {}),
        });
        for (const l of res.lines) out(l);
      } catch (err) {
        out(`failed      ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
  business
    .command("score")
    .description("Score a profile against an answer key (a test client's business.key.json)")
    .argument("<profile>", "business.proposed.json or business.json")
    .requiredOption("--key <file>", "the answer key")
    .option("--language <code>", "market language", "nl")
    .action((profileFile: string, opts: { key: string; language: string }) => {
      try {
        for (const l of businessScore({ profileFile, keyFile: opts.key, language: opts.language })
          .lines)
          out(l);
      } catch (err) {
        out(`failed      ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
  business
    .command("simulate")
    .description("Play a test client's owner from its answer key: writes owner-answers.json")
    .argument("<proposed>", "business.proposed.json")
    .requiredOption("--key <file>", "the answer key")
    .option("--language <code>", "market language", "nl")
    .option("--by <name>", "who plays the owner (recorded in the answers)")
    .option(
      "--out <file>",
      "where to write the answers (default: owner-answers.json next to the proposal)",
    )
    .action(
      (
        proposedFile: string,
        opts: { key: string; language: string; by?: string; out?: string },
      ) => {
        try {
          const res = businessSimulate({
            proposedFile,
            keyFile: opts.key,
            language: opts.language,
            ...(opts.by ? { by: opts.by } : {}),
            ...(opts.out ? { out: opts.out } : {}),
          });
          for (const l of res.lines) out(l);
        } catch (err) {
          out(`failed      ${(err as Error).message}`);
          process.exitCode = 1;
        }
      },
    );

  program
    .command("research")
    .description(
      "Steps 7-8: collect the research dataset (queries, SERPs, competitors) for a context",
    )
    .argument("<context>", "a confirmed context.json")
    .option(
      "--site <site>",
      "pages from a site URL or fixture folder (default: the context's site)",
    )
    .option(
      "--out <file>",
      "where to write the dataset (default: research.json next to the context)",
    )
    .addOption(
      new Option("--provider <name>", "LLM provider").choices(["ollama", "fake"]).default("ollama"),
    )
    .option("--model <model>", "model for seed phrasing", "deepseek-v4.1-flash")
    .option("--no-model", "deterministic seeds only")
    .option("--no-gsc", "don't use Search Console")
    .option("--live-serp", "allow paid SERP calls (otherwise only cached SERPs)")
    .option("--budget <usd>", "DataforSEO budget for this run", "1")
    .option("--allow-unconfirmed", "run on a context nobody confirmed yet (dry run)")
    .option("--debug", "mirror logs to the console")
    .action(
      async (
        contextFile: string,
        opts: {
          site?: string;
          out?: string;
          provider: string;
          model: string | false;
          gsc: boolean;
          liveSerp?: boolean;
          budget: string;
          allowUnconfirmed?: boolean;
          debug?: boolean;
        },
      ) => {
        const runsDir = program.opts<{ runsDir: string }>().runsDir;
        let res: Awaited<ReturnType<typeof research>>;
        try {
          res = await research({
            runsDir,
            contextFile,
            provider: opts.provider,
            model: opts.model === false ? "none" : opts.model,
            noModel: opts.model === false,
            gsc: opts.gsc,
            liveSerp: !!opts.liveSerp,
            budgetUsd: Number(opts.budget),
            allowUnconfirmed: !!opts.allowUnconfirmed,
            ...(opts.site ? { site: opts.site } : {}),
            ...(opts.out ? { out: opts.out } : {}),
            ...(opts.debug ? { debug: true } : {}),
          });
        } catch (err) {
          // Raised before a run exists (missing or unconfirmed context): nothing to log yet.
          out(`failed      ${(err as Error).message}`);
          process.exitCode = 1;
          return;
        }
        for (const l of res.lines) out(l);
        out("");
        out(res.timeline);
        if (!res.ok) process.exitCode = 1;
      },
    );

  program
    .command("filter")
    .description("Step 9: drop noise and score every research query (rules first, then the model)")
    .argument("<research>", "research.json written by mycel research")
    .option("--context <file>", "the confirmed context (default: context.json next to research)")
    .option("--out <file>", "where to write the result (default: queries.json next to research)")
    .addOption(
      new Option("--provider <name>", "LLM provider").choices(["ollama", "fake"]).default("ollama"),
    )
    .option("--model <model>", "model name", "deepseek-v4.1-flash")
    .option("--allow-unconfirmed", "run on a context nobody confirmed yet (dry run)")
    .option("--debug", "mirror logs to the console")
    .action(
      async (
        researchFile: string,
        opts: {
          context?: string;
          out?: string;
          provider: string;
          model: string;
          allowUnconfirmed?: boolean;
          debug?: boolean;
        },
      ) => {
        const runsDir = program.opts<{ runsDir: string }>().runsDir;
        let res: Awaited<ReturnType<typeof filterRun>>;
        try {
          res = await filterRun({
            runsDir,
            researchFile,
            provider: opts.provider,
            model: opts.model,
            allowUnconfirmed: !!opts.allowUnconfirmed,
            ...(opts.context ? { contextFile: opts.context } : {}),
            ...(opts.out ? { out: opts.out } : {}),
            ...(opts.debug ? { debug: true } : {}),
          });
        } catch (err) {
          out(`failed      ${(err as Error).message}`);
          process.exitCode = 1;
          return;
        }
        for (const l of res.lines) out(l);
        out("");
        out(res.timeline);
        if (!res.ok) process.exitCode = 1;
      },
    );

  program
    .command("cluster")
    .description(
      "Step 10: cluster kept queries on shared top-10 results and decide page / section / micro",
    )
    .argument("<queries>", "queries.json written by mycel filter")
    .option("--context <file>", "the confirmed context (default: context.json next to queries)")
    .option("--out <file>", "where to write clusters (default: clusters.json next to queries)")
    .option("--live-serp", "allow paid SERP calls (otherwise only cached SERPs)")
    .option("--budget <usd>", "DataforSEO budget for this run", "3")
    .option("--min-shared <n>", "shared top-10 URLs for one page (ADR 0003)", "3")
    .option("--allow-unconfirmed", "run on a context nobody confirmed yet (dry run)")
    .option("--debug", "mirror logs to the console")
    .action(
      async (
        queriesFile: string,
        opts: {
          context?: string;
          out?: string;
          liveSerp?: boolean;
          budget: string;
          minShared: string;
          allowUnconfirmed?: boolean;
          debug?: boolean;
        },
      ) => {
        const runsDir = program.opts<{ runsDir: string }>().runsDir;
        let res: Awaited<ReturnType<typeof clusterRun>>;
        try {
          res = await clusterRun({
            runsDir,
            queriesFile,
            liveSerp: !!opts.liveSerp,
            budgetUsd: Number(opts.budget),
            minShared: Number(opts.minShared),
            allowUnconfirmed: !!opts.allowUnconfirmed,
            ...(opts.context ? { contextFile: opts.context } : {}),
            ...(opts.out ? { out: opts.out } : {}),
            ...(opts.debug ? { debug: true } : {}),
          });
        } catch (err) {
          out(`failed      ${(err as Error).message}`);
          process.exitCode = 1;
          return;
        }
        for (const l of res.lines) out(l);
        out("");
        out(res.timeline);
        if (!res.ok) process.exitCode = 1;
      },
    );

  program
    .command("map")
    .description(
      "Steps 11-14 and 20: build the topical map (core/outer tree, intent, priority, existing pages, links)",
    )
    .argument("<clusters>", "clusters.json written by mycel cluster")
    .option("--queries <file>", "queries.json for intent and CPC (default: next to clusters)")
    .option("--context <file>", "the confirmed context (default: context.json next to clusters)")
    .option(
      "--pages <file>",
      "existing pages: pages.json or research.json (default: research.json next to clusters)",
    )
    .option("--expect <file>", "a test client's expectations.json: check the map against it")
    .option("--out <file>", "where to write the map (default: topical-map.json next to clusters)")
    .addOption(
      new Option("--provider <name>", "LLM provider").choices(["ollama", "fake"]).default("ollama"),
    )
    .option("--model <model>", "model name", "deepseek-v4.1-flash")
    .option("--allow-unconfirmed", "run on a context nobody confirmed yet (dry run)")
    .option("--debug", "mirror logs to the console")
    .action(
      async (
        clustersFile: string,
        opts: {
          queries?: string;
          context?: string;
          pages?: string;
          expect?: string;
          out?: string;
          provider: string;
          model: string;
          allowUnconfirmed?: boolean;
          debug?: boolean;
        },
      ) => {
        const runsDir = program.opts<{ runsDir: string }>().runsDir;
        let res: Awaited<ReturnType<typeof mapRun>>;
        try {
          res = await mapRun({
            runsDir,
            clustersFile,
            provider: opts.provider,
            model: opts.model,
            allowUnconfirmed: !!opts.allowUnconfirmed,
            ...(opts.queries ? { queriesFile: opts.queries } : {}),
            ...(opts.context ? { contextFile: opts.context } : {}),
            ...(opts.pages ? { pagesFile: opts.pages } : {}),
            ...(opts.expect ? { expectFile: opts.expect } : {}),
            ...(opts.out ? { out: opts.out } : {}),
            ...(opts.debug ? { debug: true } : {}),
          });
        } catch (err) {
          out(`failed      ${(err as Error).message}`);
          process.exitCode = 1;
          return;
        }
        for (const l of res.lines) out(l);
        out("");
        out(res.timeline);
        if (!res.ok) process.exitCode = 1;
      },
    );

  const gsc = program.command("gsc").description("Google Search Console tools");
  gsc
    .command("check")
    .description("Check the GSC key and access, and show the top queries of the last 28 days")
    .option("--property <property>", "GSC property (default: GSC_PROPERTY)")
    .option("--debug", "mirror logs to the console")
    .action(async (opts: { property?: string; debug?: boolean }) => {
      const runsDir = program.opts<{ runsDir: string }>().runsDir;
      const res = await gscCheck({ runsDir, ...opts });
      for (const l of res.lines) out(l);
      out("");
      out(res.timeline);
      if (!res.ok) process.exitCode = 1;
    });

  const evals = program.command("eval").description("Evaluations");
  evals
    .command("filter")
    .description(
      "Score the step 9 filter on the labeled queries of the test clients: the tuning set and the held-out set (issue #17). Fails below the pass mark",
    )
    .argument("[fixtures...]", "fixture folders with filter-eval.json and filter-holdout.json", [
      "fixtures/clients/plantpost",
      "fixtures/clients/praktijk-beweegruimte",
    ])
    .addOption(
      new Option("--provider <name>", "LLM provider").choices(["ollama", "fake"]).default("ollama"),
    )
    .option("--model <model>", "model name", "deepseek-v4.1-flash")
    .option(
      "--min-accuracy <share>",
      "share of labeled queries each set must get right, 0 to 1",
      String(DEFAULT_MIN_ACCURACY),
    )
    .option("--debug", "mirror logs to the console")
    .action(
      async (
        fixtures: string[],
        opts: { provider: string; model: string; minAccuracy: string; debug?: boolean },
      ) => {
        const runsDir = program.opts<{ runsDir: string }>().runsDir;
        let res: Awaited<ReturnType<typeof filterEval>>;
        try {
          res = await filterEval({
            runsDir,
            fixtures,
            provider: opts.provider,
            model: opts.model,
            minAccuracy: Number(opts.minAccuracy),
            ...(opts.debug ? { debug: true } : {}),
          });
        } catch (err) {
          out(`failed      ${(err as Error).message}`);
          process.exitCode = 1;
          return;
        }
        for (const l of res.lines) out(l);
        if (!res.ok) process.exitCode = 1;
      },
    );
  evals
    .command("map")
    .description(
      "Score a topical map on the round-8 numbers (issue #42): duplicate intents, offer fit, first plan, existing pages. Cache only, no paid calls",
    )
    .argument("<map>", "topical-map.json written by mycel map")
    .option("--context <file>", "the client's context (default: context.json next to the map)")
    .option(
      "--pages <file>",
      "existing pages: pages.json or research.json (default: research.json next to the map)",
    )
    .option("--out <file>", "where to write the eval (default: map-eval.json next to the map)")
    .option("--review", "also write the two reviewer prompts (SEO expert, owner)")
    .option("--no-serps", "skip the SERP overlap check")
    .option("--debug", "mirror logs to the console")
    .action(
      async (
        mapFile: string,
        opts: {
          context?: string;
          pages?: string;
          out?: string;
          review?: boolean;
          serps: boolean;
          debug?: boolean;
        },
      ) => {
        const runsDir = program.opts<{ runsDir: string }>().runsDir;
        let res: Awaited<ReturnType<typeof evalMapRun>>;
        try {
          res = await evalMapRun({
            runsDir,
            mapFile,
            serps: opts.serps,
            ...(opts.context ? { contextFile: opts.context } : {}),
            ...(opts.pages ? { pagesFile: opts.pages } : {}),
            ...(opts.out ? { out: opts.out } : {}),
            ...(opts.review ? { review: true } : {}),
            ...(opts.debug ? { debug: true } : {}),
          });
        } catch (err) {
          out(`failed      ${(err as Error).message}`);
          process.exitCode = 1;
          return;
        }
        for (const l of res.lines) out(l);
        out("");
        out(res.timeline);
        if (!res.ok) process.exitCode = 1;
      },
    );
  const writing = evals
    .command("writing")
    .description("Dutch writing test: which model writes the text (issue #12)");
  writing
    .command("run")
    .description("Let each model write every task, then make a blind score sheet")
    .requiredOption("--tasks <file>", "task set JSON (WritingTestSet)")
    .option(
      "--models <list>",
      "comma-separated writers; add +en for English instructions (e.g. deepseek-v4.1-flash,deepseek-v4.1-flash+en)",
      "deepseek-v4.1-flash,gemma4:31b,mistral-large-4",
    )
    .addOption(
      new Option("--provider <name>", "LLM provider").choices(["ollama", "fake"]).default("ollama"),
    )
    .option("--debug", "mirror logs to the console")
    .action(async (opts: { tasks: string; models: string; provider: string; debug?: boolean }) => {
      const runsDir = program.opts<{ runsDir: string }>().runsDir;
      const res = await writingRun({
        runsDir,
        tasksPath: opts.tasks,
        models: opts.models
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean),
        provider: opts.provider,
        ...(opts.debug ? { debug: true } : {}),
      });
      for (const l of res.lines) out(l);
      out("");
      out(res.timeline);
      if (!res.ok) process.exitCode = 1;
    });
  writing
    .command("score")
    .description("Unblind the filled-in scores.csv and apply the decision rule")
    .argument("<run>", 'run id, unique prefix, or "latest"')
    .option("--candidate <model>", "the cheap model that should win", "deepseek-v4.1-flash")
    .action((run: string, opts: { candidate: string }) => {
      const runsDir = program.opts<{ runsDir: string }>().runsDir;
      for (const l of writingScore({ runsDir, run, candidate: opts.candidate }).lines) out(l);
    });

  return program;
}
