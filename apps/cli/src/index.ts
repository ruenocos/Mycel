import { existsSync } from "node:fs";
import { setRunProgress } from "@mycel/core";
import { CommanderError } from "commander";
import { buildProgram } from "./program.ts";

// Local keys (never committed). Real env vars win.
if (existsSync(".env")) process.loadEnvFile(".env");

// Which step is running goes to stderr, so a long run isn't silent and stdout stays the result.
setRunProgress((line) => process.stderr.write(`${line}\n`));

try {
  await buildProgram().parseAsync(process.argv);
} catch (err) {
  // commander already printed its message. Help and --version end here with 0; a wrong flag
  // or argument is a usage error (exit code 2). Anything else is a bug: let it show.
  if (!(err instanceof CommanderError)) throw err;
  process.exitCode = err.exitCode === 0 ? 0 : 2;
}
