import { existsSync } from "node:fs";
import { interruptActiveRuns, setRunProgress } from "@mycel/core";
import { runCli } from "./program.ts";

// Local keys (never committed). Real env vars win.
if (existsSync(".env")) process.loadEnvFile(".env");

// Which step is running goes to stderr, so a long run isn't silent and stdout stays the result.
setRunProgress((line) => process.stderr.write(`${line}\n`));

// Ctrl+C or a kill: write down that the run was stopped, so it doesn't say "running" for ever.
// 130 and 143 are the usual exit codes for these two signals.
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, () => {
    for (const run of interruptActiveRuns(signal)) {
      const lines = [
        `interrupted ${run.command} for ${run.client}, run ${run.runId}`,
        "            what was paid for is in the cache: the next run does not buy it again",
      ];
      if (run.command === "research") {
        lines.push(`retry       the same command with --resume ${run.runId}`);
      }
      process.stderr.write(`${lines.join("\n")}\n`);
    }
    process.exit(code);
  });
}

await runCli(process.argv);
