import { CORE_VERSION, formatTimeline, type LogLevel, listRuns, resolveRunId } from "@mycel/core";
import { Command, Option } from "commander";
import { writingRun, writingScore } from "./eval-writing.ts";
import { gscCheck } from "./gsc-check.ts";
import { llmPing } from "./llm-ping.ts";

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

  const writing = program
    .command("eval")
    .description("Evaluations")
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
