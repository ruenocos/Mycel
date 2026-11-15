import { type ErrorInfo, formatRunSummary, formatTimeline, summarizeRun } from "@mycel/core";
import { describeError, EXIT_CODES } from "./errors.ts";
import { command } from "./input.ts";

/**
 * One way for every command to end (issue #43): print the result, the short run summary and the
 * next step; on failure print what went wrong, the fix and the code, and set the exit code.
 */

/** What to do after this command: a command to paste, with an optional remark under it. */
export interface NextStep {
  command?: string;
  note?: string;
}

export interface CommandResult {
  ok: boolean;
  /** Set when the command ran inside a run (most do). */
  runId?: string;
  /** The command's own summary, one `label      value` per line. */
  lines: string[];
  /** Files written, by what they are: { clusters: "clients/x/clusters.json" }. */
  outputs?: Record<string, string>;
  next?: NextStep[];
  /** Why the command isn't ok: the caught error, or a MycelError for a missed pass mark. */
  failure?: unknown;
}

export interface CommandIo {
  /** Results: stdout. */
  out(line: string): void;
  /** Errors and progress: stderr. */
  err(line: string): void;
  setExitCode(code: number): void;
}

export interface RunCommandOptions {
  runsDir: string;
  /** "summary" (default): one line per step. "full": the whole timeline, for the small check commands. */
  timeline?: "summary" | "full";
  /** Also print the stack of an error. */
  debug?: boolean;
}

const LABEL = 12;
const row = (label: string, text: string) =>
  text
    .split("\n")
    .map((l, i) => `${(i === 0 ? label : "").padEnd(LABEL)}${l}`)
    .join("\n");

export function formatError(info: ErrorInfo, runId?: string): string[] {
  const lines = [row("error", info.message)];
  if (info.fix) lines.push(row("fix", info.fix));
  lines.push(
    row("code", `${info.code} (${info.transient ? "a retry can help" : "a retry will not help"})`),
  );
  if (runId) lines.push(row("log", command("logs", runId, "--level", "debug")));
  return lines;
}

function fail(io: CommandIo, err: unknown, opts: RunCommandOptions, runId?: string): void {
  const info = describeError(err);
  for (const l of formatError(info, runId)) io.err(l);
  if (opts.debug && err instanceof Error && err.stack) io.err(err.stack);
  io.setExitCode(EXIT_CODES[info.code]);
}

export async function runCommand(
  io: CommandIo,
  opts: RunCommandOptions,
  fn: () => Promise<CommandResult> | CommandResult,
): Promise<void> {
  let res: CommandResult;
  try {
    res = await fn();
  } catch (err) {
    // Raised before a run exists: a bad flag, a missing or unconfirmed input.
    fail(io, err, opts);
    return;
  }
  for (const l of res.lines) io.out(l);
  if (res.runId) {
    if (res.lines.length) io.out("");
    if (opts.timeline === "full") io.out(formatTimeline(opts.runsDir, res.runId));
    else for (const l of formatRunSummary(summarizeRun(opts.runsDir, res.runId))) io.out(l);
  }
  for (const [name, path] of Object.entries(res.outputs ?? {})) {
    io.out(row("wrote", `${path}  (${name})`));
  }
  if (!res.ok) {
    fail(
      io,
      res.failure ?? new Error("the run did not finish cleanly; the log has the details"),
      opts,
      res.runId,
    );
    return;
  }
  for (const [i, n] of (res.next ?? []).entries()) {
    if (n.command) io.out(row(i === 0 ? "next" : "", n.command));
    if (n.note) io.out(row(i === 0 && !n.command ? "next" : "", n.note));
  }
}
