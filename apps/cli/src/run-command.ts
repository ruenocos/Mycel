import { type ErrorInfo, formatRunSummary, formatTimeline, summarizeRun } from "@mycel/core";
import { CliOutput } from "@mycel/schema";
import { describeError, EXIT_CODES } from "./errors.ts";
import { command } from "./input.ts";

/**
 * One way for every command to end (issue #43): print the result, the short run summary and the
 * next step; on failure print what went wrong, the fix and the code, and set the exit code.
 * With `--json` the same result is one object on stdout instead (issue #45, ADR 0015).
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
  /**
   * The result in numbers, for `--json`: counts, scores, a cost plan. Small on purpose: the
   * dataset stays in the files that `outputs` points to.
   */
  data?: Record<string, unknown>;
  next?: NextStep[];
  /** Why the command isn't ok: the caught error, or a MycelError for a missed pass mark. */
  failure?: unknown;
  /** After a failure: the command that picks the work up again without redoing what finished. */
  retry?: string;
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
  /** `--json`: print the output contract (ADR 0015) on stdout, and nothing else there. */
  json?: JsonIdentity;
}

/** What the JSON output says about itself: the command as typed, and the code that ran. */
export interface JsonIdentity {
  command: string;
  version: string;
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

/** The two labels commands use for "this didn't stop me, but read it". */
const NOTE = /^(note|warning)\s+/;
const isNote = (line: string) => NOTE.test(line);

/**
 * The output contract for one command (ADR 0015). `note` and `warning` lines become warnings; every other
 * line is the summary. Checked against the schema before it leaves, so a wrong shape is a bug
 * here and not a surprise for the caller.
 */
export function jsonOutput(
  id: JsonIdentity,
  runsDir: string,
  res: CommandResult | undefined,
  err: unknown,
): CliOutput {
  const info = err === undefined ? undefined : describeError(err);
  const run = res?.runId ? summarizeRun(runsDir, res.runId) : undefined;
  const lines = (res?.lines ?? []).flatMap((l) => l.split("\n"));
  const warnings = lines.filter(isNote).map((l) => l.replace(NOTE, ""));
  if (run?.warnings) {
    warnings.push(
      `${run.warnings} warnings in the log: ${command("logs", run.runId, "--level", "warn")}`,
    );
  }
  return CliOutput.parse({
    status: info ? "failed" : "ok",
    command: id.command,
    version: id.version,
    exitCode: info ? EXIT_CODES[info.code] : 0,
    ...(res?.runId ? { runId: res.runId } : {}),
    outputs: res?.outputs ?? {},
    summary: lines.filter((l) => !isNote(l)),
    ...(res?.data ? { data: res.data } : {}),
    costUsd: run?.costUsd ?? 0,
    steps: run?.steps ?? [],
    warnings,
    next: info ? [] : (res?.next ?? []),
    ...(info && res?.retry ? { retry: res.retry } : {}),
    ...(info
      ? {
          error: {
            code: info.code,
            message: info.message,
            ...(info.fix ? { fix: info.fix } : {}),
            transient: info.transient,
          },
        }
      : {}),
  });
}

/** `--json`: the whole result is one line on stdout. Only the stack of `--debug` goes to stderr. */
function finishJson(
  io: CommandIo,
  opts: RunCommandOptions & { json: JsonIdentity },
  res: CommandResult | undefined,
  err: unknown,
): void {
  const output = jsonOutput(opts.json, opts.runsDir, res, err);
  io.out(JSON.stringify(output));
  if (opts.debug && err instanceof Error && err.stack) io.err(err.stack);
  io.setExitCode(output.exitCode);
}

const NOT_CLEAN = () => new Error("the run did not finish cleanly; the log has the details");

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
    if (opts.json) finishJson(io, { ...opts, json: opts.json }, undefined, err);
    else fail(io, err, opts);
    return;
  }
  if (opts.json) {
    const failure = res.ok ? undefined : (res.failure ?? NOT_CLEAN());
    finishJson(io, { ...opts, json: opts.json }, res, failure);
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
    fail(io, res.failure ?? NOT_CLEAN(), opts, res.runId);
    if (res.retry) io.err(row("retry", res.retry));
    return;
  }
  for (const [i, n] of (res.next ?? []).entries()) {
    if (n.command) io.out(row(i === 0 ? "next" : "", n.command));
    if (n.note) io.out(row(i === 0 && !n.command ? "next" : "", n.note));
  }
}
