import { CORE_VERSION, formatTimeline, type LogLevel, listRuns, resolveRunId } from "@mycel/core";
import { Command, Option } from "commander";

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

  return program;
}
