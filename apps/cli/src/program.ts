import { createInterface } from "node:readline/promises";
import { CORE_VERSION, formatTimeline, type LogLevel, listRuns, resolveRunId } from "@mycel/core";
import { Command, Option } from "commander";
import { clusterRun } from "./cluster.ts";
import { contextConfirm, contextPropose } from "./context.ts";
import { writingRun, writingScore } from "./eval-writing.ts";
import { DEFAULT_MIN_ACCURACY, filterEval, filterRun } from "./filter.ts";
import { gscCheck } from "./gsc-check.ts";
import { command } from "./input.ts";
import { llmPing } from "./llm-ping.ts";
import { mapRun } from "./map.ts";
import { research } from "./research.ts";
import { type CommandIo, type CommandResult, runCommand } from "./run-command.ts";

/** The model that writes (ADR 0012). One place, so a switch is one edit. */
export const DEFAULT_MODEL = "deepseek-v4.1-flash";

const usd = (n: number) => `$${n.toFixed(4)}`;

const provider = () =>
  new Option("--provider <name>", "LLM provider").choices(["ollama", "fake"]).default("ollama");
const DEBUG = ["--debug", "follow the log on stderr, and show the stack of an error"] as const;
const UNCONFIRMED = [
  "--allow-unconfirmed",
  "run on a context nobody confirmed yet (dry run)",
] as const;

const examples = (...lines: string[]) => `\nExamples:\n${lines.map((l) => `  ${l}`).join("\n")}\n`;

/** Shown under `mycel --help`: the route through the pipeline, and what each exit code means. */
const ROUTE = `
A typical run, in order (every command prints the next one with its paths filled in):
  mycel context propose https://example.com
  mycel context confirm clients/example.com/context.json
  mycel research clients/example.com/context.json
  mycel filter clients/example.com/research.json
  mycel cluster clients/example.com/queries.json --live-serp --budget 3
  mycel map clients/example.com/clusters.json
  mycel logs latest

Keys live in .env (.env.example lists every key). Check them before a paid run:
  mycel llm ping     OLLAMA_API_KEY: the model that reads and writes
  mycel gsc check    GSC_CREDENTIALS_PATH, GSC_PROPERTY: Search Console (optional, --no-gsc)
  DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD: search data for research and cluster --live-serp
  (context propose uses it when set; --no-dataforseo leaves it out)

Every run is saved under --runs-dir (default: runs/). Add --debug to any command to follow
the log on stderr while it runs; mycel logs <run> --level debug shows it afterwards.

Exit codes:
   0  done
   1  the run failed: read the log
   2  wrong flag or argument
   3  an input file is missing, wrong or not confirmed: run the earlier step
   4  a key is missing or was refused: check .env
   5  the command would replace a file a person confirmed: use --out or --force
  10  the run worked, but a quality gate or eval is below its pass mark
  11  the budget is reached, or a paid call is needed and not allowed
  75  temporary (network, rate limit): run the same command again
`;

export function buildProgram(
  out: (s: string) => void = (s) => console.log(s),
  io: Partial<Omit<CommandIo, "out">> = {},
): Command {
  const cio: CommandIo = {
    out,
    err: io.err ?? ((s) => console.error(s)),
    setExitCode:
      io.setExitCode ??
      ((code) => {
        process.exitCode = code;
      }),
  };
  const program = new Command()
    .name("mycel")
    .description("Build a data-driven topical map. A human approves everything.")
    .version(CORE_VERSION)
    .option("--runs-dir <dir>", "where runs are stored", "runs")
    // A wrong flag throws instead of exiting, so index.ts can give it exit code 2.
    .exitOverride()
    .configureOutput({
      // commander's own messages (a wrong flag, a typo in a command) in the same shape and on
      // the same stream as every other error.
      writeErr: (s) => cio.err(s.trimEnd()),
      outputError: (s, write) => write(s.replace(/^error: /, "error       ")),
    })
    .showHelpAfterError(
      "fix         mycel --help shows the commands, their order and the exit codes",
    )
    .addHelpText("after", ROUTE);
  const runsDir = () => program.opts<{ runsDir: string }>().runsDir;
  /** Every command ends the same way: result, run summary, next step; or error, fix, code. */
  const run = (
    opts: { debug?: boolean | undefined; timeline?: "full" },
    fn: () => Promise<CommandResult> | CommandResult,
  ) =>
    runCommand(
      cio,
      {
        runsDir: runsDir(),
        ...(opts.timeline ? { timeline: opts.timeline } : {}),
        ...(opts.debug ? { debug: true } : {}),
      },
      fn,
    );

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
    .addOption(provider())
    .option("--model <model>", "model name", DEFAULT_MODEL)
    .option("--no-gsc", "don't use Search Console")
    .option("--no-dataforseo", "don't use DataforSEO")
    .option("--budget <usd>", "DataforSEO budget for this run", "0.5")
    .option(
      "--force",
      "replace a context that was already confirmed or reviewed (a backup is kept next to it)",
    )
    .option(...DEBUG)
    .addHelpText(
      "after",
      examples(
        "mycel context propose https://example.com",
        'mycel context propose fixtures/clients/plantpost --market "NL / nl" --provider fake --out /tmp/context.json',
      ),
    )
    .action(
      (
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
      ) =>
        run(opts, () =>
          contextPropose({
            runsDir: runsDir(),
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
          }),
        ),
    );
  context
    .command("confirm")
    .description("Go through a proposed context in the terminal: keep or edit every answer")
    .argument("<file>", "context.json written by mycel context propose")
    .option("--by <name>", "who confirms (default: your OS user name)")
    .option(...DEBUG)
    .addHelpText("after", examples("mycel context confirm clients/example.com/context.json"))
    .action((file: string, opts: { by?: string; debug?: boolean }) =>
      run(opts, async () => {
        const by = opts.by ?? process.env.USERNAME ?? process.env.USER ?? "unknown";
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          await contextConfirm(file, by, { print: out, ask: (p) => rl.question(p) });
        } finally {
          rl.close();
        }
        return { ok: true, lines: [], next: [{ command: command("research", file) }] };
      }),
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
    .addOption(provider())
    .option("--model <model>", "model for seed phrasing", DEFAULT_MODEL)
    .option("--no-model", "deterministic seeds only")
    .option("--no-gsc", "don't use Search Console")
    .option("--live-serp", "allow paid SERP calls (otherwise only cached SERPs)")
    .option("--budget <usd>", "DataforSEO budget for this run", "1")
    .option(...UNCONFIRMED)
    .option(...DEBUG)
    .addHelpText(
      "after",
      examples(
        "mycel research clients/example.com/context.json",
        "mycel research clients/example.com/context.json --live-serp --budget 2",
      ),
    )
    .action(
      (
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
      ) =>
        run(opts, () =>
          research({
            runsDir: runsDir(),
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
          }),
        ),
    );

  program
    .command("filter")
    .description("Step 9: drop noise and score every research query (rules first, then the model)")
    .argument("<research>", "research.json written by mycel research")
    .option("--context <file>", "the confirmed context (default: context.json next to research)")
    .option("--out <file>", "where to write the result (default: queries.json next to research)")
    .addOption(provider())
    .option("--model <model>", "model name", DEFAULT_MODEL)
    .option(...UNCONFIRMED)
    .option(...DEBUG)
    .addHelpText("after", examples("mycel filter clients/example.com/research.json"))
    .action(
      (
        researchFile: string,
        opts: {
          context?: string;
          out?: string;
          provider: string;
          model: string;
          allowUnconfirmed?: boolean;
          debug?: boolean;
        },
      ) =>
        run(opts, () =>
          filterRun({
            runsDir: runsDir(),
            researchFile,
            provider: opts.provider,
            model: opts.model,
            allowUnconfirmed: !!opts.allowUnconfirmed,
            ...(opts.context ? { contextFile: opts.context } : {}),
            ...(opts.out ? { out: opts.out } : {}),
            ...(opts.debug ? { debug: true } : {}),
          }),
        ),
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
    .option(...UNCONFIRMED)
    .option(...DEBUG)
    .addHelpText(
      "after",
      examples(
        "mycel cluster clients/example.com/queries.json",
        "mycel cluster clients/example.com/queries.json --live-serp --budget 3",
      ),
    )
    .action(
      (
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
      ) =>
        run(opts, () =>
          clusterRun({
            runsDir: runsDir(),
            queriesFile,
            liveSerp: !!opts.liveSerp,
            budgetUsd: Number(opts.budget),
            minShared: Number(opts.minShared),
            allowUnconfirmed: !!opts.allowUnconfirmed,
            ...(opts.context ? { contextFile: opts.context } : {}),
            ...(opts.out ? { out: opts.out } : {}),
            ...(opts.debug ? { debug: true } : {}),
          }),
        ),
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
    .addOption(provider())
    .option("--model <model>", "model name", DEFAULT_MODEL)
    .option(...UNCONFIRMED)
    .option(...DEBUG)
    .addHelpText(
      "after",
      examples(
        "mycel map clients/example.com/clusters.json",
        "mycel map clients/plantpost.example/clusters.json --expect fixtures/clients/plantpost/expectations.json",
      ),
    )
    .action(
      (
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
      ) =>
        run(opts, () =>
          mapRun({
            runsDir: runsDir(),
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
          }),
        ),
    );

  program
    .command("logs")
    .description("Show a readable timeline of a run, or list recent runs")
    .argument("[run]", 'run id, unique prefix, or "latest"')
    .addOption(
      new Option("--level <level>", "minimum level to show")
        .choices(["debug", "info", "warn", "error"])
        .default("info"),
    )
    .option(...DEBUG)
    .addHelpText(
      "after",
      examples("mycel logs", "mycel logs latest", "mycel logs 2026-11-14T08 --level warn"),
    )
    .action((runArg: string | undefined, opts: { level: LogLevel; debug?: boolean }) =>
      run(opts, () => {
        if (!runArg) {
          const runs = listRuns(runsDir()).slice(0, 15);
          if (runs.length === 0) return { ok: true, lines: [`No runs in ${runsDir()}.`] };
          return {
            ok: true,
            lines: runs.map(
              (r) =>
                `${r.runId}  ${r.status.padEnd(7)}  ${r.client}  ${r.command}  ${usd(r.costUsd)}`,
            ),
          };
        }
        const runId = resolveRunId(runsDir(), runArg);
        return { ok: true, lines: [formatTimeline(runsDir(), runId, { minLevel: opts.level })] };
      }),
    );

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
    .addOption(provider())
    .option("--model <model>", "model name", DEFAULT_MODEL)
    .option(
      "--min-accuracy <share>",
      "share of labeled queries each set must get right, 0 to 1",
      String(DEFAULT_MIN_ACCURACY),
    )
    .option(...DEBUG)
    .addHelpText(
      "after",
      examples("mycel eval filter", "mycel eval filter fixtures/clients/plantpost --provider fake"),
    )
    .action(
      (
        fixtures: string[],
        opts: { provider: string; model: string; minAccuracy: string; debug?: boolean },
      ) =>
        run(opts, () =>
          filterEval({
            runsDir: runsDir(),
            fixtures,
            provider: opts.provider,
            model: opts.model,
            minAccuracy: Number(opts.minAccuracy),
            ...(opts.debug ? { debug: true } : {}),
          }),
        ),
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
      `comma-separated writers; add +en for English instructions (e.g. ${DEFAULT_MODEL},${DEFAULT_MODEL}+en)`,
      `${DEFAULT_MODEL},gemma4:31b,mistral-large-4`,
    )
    .addOption(provider())
    .option(...DEBUG)
    .action((opts: { tasks: string; models: string; provider: string; debug?: boolean }) =>
      run(opts, () =>
        writingRun({
          runsDir: runsDir(),
          tasksPath: opts.tasks,
          models: opts.models
            .split(",")
            .map((m) => m.trim())
            .filter(Boolean),
          provider: opts.provider,
          ...(opts.debug ? { debug: true } : {}),
        }),
      ),
    );
  writing
    .command("score")
    .description("Unblind the filled-in scores.csv and apply the decision rule")
    .argument("<run>", 'run id, unique prefix, or "latest"')
    .option("--candidate <model>", "the cheap model that should win", DEFAULT_MODEL)
    .option(...DEBUG)
    .action((runArg: string, opts: { candidate: string; debug?: boolean }) =>
      run(opts, () => ({
        ok: true,
        lines: writingScore({ runsDir: runsDir(), run: runArg, candidate: opts.candidate }).lines,
      })),
    );

  const gsc = program.command("gsc").description("Google Search Console tools");
  gsc
    .command("check")
    .description("Check the GSC key and access, and show the top queries of the last 28 days")
    .option("--property <property>", "GSC property (default: GSC_PROPERTY)")
    .option(...DEBUG)
    .action((opts: { property?: string; debug?: boolean }) =>
      run({ ...opts, timeline: "full" }, () => gscCheck({ runsDir: runsDir(), ...opts })),
    );

  const llm = program.command("llm").description("LLM provider tools");
  llm
    .command("ping")
    .description("One logged LLM call, to check provider, key and logging")
    .addOption(provider())
    .option("--model <model>", "model name", DEFAULT_MODEL)
    .option(...DEBUG)
    .action((opts: { provider: string; model: string; debug?: boolean }) =>
      run({ ...opts, timeline: "full" }, () => llmPing({ runsDir: runsDir(), ...opts })),
    );

  return program;
}
