import { existsSync, readdirSync, readFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { MycelError } from "./errors.ts";
import type { LogLevel, LogLine, RunMeta, RunStatus, StepStatus } from "./types.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 sends nothing: it only asks whether the process exists
    return true;
  } catch (err) {
    // EPERM: it exists, but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The status to show. A run that says "running" on disk but whose process is gone (the PC was
 * switched off, the process was killed) is "stopped": nothing will ever finish it. A run from
 * before the machine last started can't be alive either, whoever holds its process id now.
 */
export function runStatus(
  meta: RunMeta,
  probe: { alive(pid: number): boolean; bootedAt: number } = {
    alive,
    bootedAt: Date.now() - uptime() * 1000,
  },
): RunStatus {
  if (meta.status !== "running") return meta.status;
  // Runs from before run.json stored a pid: no way to tell, so say what the file says.
  if (meta.pid === undefined) return "running";
  if (new Date(meta.startedAt).getTime() < probe.bootedAt - 60_000) return "stopped";
  return probe.alive(meta.pid) ? "running" : "stopped";
}

export function listRuns(runsDir: string): RunMeta[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(runsDir, d.name, "run.json")))
    .map((d) => readRunMeta(runsDir, d.name))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function readRunMeta(runsDir: string, runId: string): RunMeta {
  return JSON.parse(readFileSync(join(runsDir, runId, "run.json"), "utf8")) as RunMeta;
}

export function readRunLog(runsDir: string, runId: string): LogLine[] {
  const path = join(runsDir, runId, "log.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as LogLine);
}

/** Resolves "latest" or a unique prefix to a full run id. */
export function resolveRunId(runsDir: string, idOrPrefix: string): string {
  const runs = listRuns(runsDir);
  const fix = "mycel logs lists the recent runs";
  if (idOrPrefix === "latest") {
    const latest = runs[0];
    if (!latest) throw new MycelError("RUN_NOT_FOUND", `no runs in ${runsDir}`);
    return latest.runId;
  }
  const matches = runs.filter((r) => r.runId.startsWith(idOrPrefix));
  const only = matches[0];
  if (matches.length === 1 && only) return only.runId;
  if (matches.length === 0) {
    throw new MycelError("RUN_NOT_FOUND", `no run matches "${idOrPrefix}" in ${runsDir}`, { fix });
  }
  throw new MycelError(
    "RUN_NOT_FOUND",
    `"${idOrPrefix}" matches ${matches.length} runs, be more specific`,
    { fix },
  );
}

const usd = (n: unknown) => (typeof n === "number" ? `$${n.toFixed(4)}` : "");
const ms = (n: unknown) => (typeof n === "number" ? `${n}ms` : "");
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function describe(line: LogLine): string {
  const d = line.data ?? {};
  switch (line.event) {
    case "run.start":
      return `▶ run start  git=${d.gitCommit ?? "none"}  cli=${d.cliVersion ?? "?"}`;
    case "run.end":
      return `${line.level === "error" ? "✗" : "■"} ${line.msg}  total ${usd(d.costUsd)}`;
    case "step.start":
      return `▶ ${line.step}`;
    case "step.ok":
      return `✓ ${line.step}  ${ms(d.durationMs)}  ${usd(d.costUsd)}`;
    case "step.failed":
      return `✗ ${line.step} FAILED  ${ms(d.durationMs)}`;
    case "llm.call": {
      const tok =
        d.inputTokens !== undefined ? `  ${d.inputTokens}→${d.outputTokens ?? "?"} tok` : "";
      const digest = d.modelDigest ? `@${String(d.modelDigest).slice(0, 12)}` : "";
      const err = d.error ? `  ERROR ${d.error}` : "";
      return `  llm  ${d.provider} ${d.model}${digest}  ${d.promptTemplate}${tok}  ${ms(d.latencyMs)}  ${usd(d.costUsd)}  try ${d.attempt}${err}  → ${d.file}`;
    }
    case "api.call": {
      const err = d.error ? `  ERROR ${d.error}` : "";
      return `  api  ${line.msg}  ${d.cache}  ${d.status}  ${ms(d.latencyMs)}  ${usd(d.costUsd)}${err}`;
    }
    default: {
      const data = line.data ? `  ${JSON.stringify(line.data)}` : "";
      return `  ${line.level.padEnd(5)} ${line.msg}${data}`;
    }
  }
}

export interface TimelineOptions {
  minLevel?: LogLevel;
}

/** Human-readable timeline of one run, for `mycel logs`. */
export function formatTimeline(runsDir: string, runId: string, opts: TimelineOptions = {}): string {
  const meta = readRunMeta(runsDir, runId);
  const min = LEVELS[opts.minLevel ?? "info"];
  const out: string[] = [
    `Run ${meta.runId}`,
    `  client ${meta.client} · command ${meta.command} · status ${runStatus(meta)} · cost ${usd(meta.costUsd)} · git ${meta.gitCommit ?? "none"}`,
    "",
  ];
  for (const line of readRunLog(runsDir, runId)) {
    if (LEVELS[line.level] < min) continue;
    out.push(`${line.ts.slice(11, 23)}  ${describe(line)}`);
    if (line.err && line.event !== "run.end") {
      out.push(`              ${line.err.name}: ${line.err.message}`);
      const frame = line.err.stack?.split("\n")[1]?.trim();
      if (frame) out.push(`              ${frame}`);
    }
  }
  const failed = meta.steps.filter((s) => s.status === "failed");
  if (failed.length > 0) {
    out.push("", `Failed: ${failed.map((s) => s.name).join(", ")}. Full stack traces in run.json.`);
  }
  const status = runStatus(meta);
  if (status === "interrupted" || status === "stopped") {
    const busy = meta.steps.filter((s) => s.status === "running" || s.status === "interrupted");
    const during = busy.length ? ` during ${busy.map((s) => s.name).join(", ")}` : "";
    out.push(
      "",
      status === "interrupted"
        ? `Interrupted${during}. What was paid for is in the cache.`
        : `Stopped${during}: the process that ran it is gone. What was paid for is in the cache.`,
    );
  }
  return out.join("\n");
}

export interface RunStepSummary {
  name: string;
  status: StepStatus;
  /** Undefined while the step is still running (or the run was killed). */
  durationMs?: number;
  costUsd: number;
  llmCalls: number;
  apiCalls: number;
  /** How many of the API calls were answered from the cache. */
  cachedApiCalls: number;
  /** The step did not run: its output was taken from this earlier run (--resume). */
  reusedFrom?: string;
}

/** A run in a handful of numbers: what the end of a command shows instead of the full timeline. */
export interface RunSummary {
  runId: string;
  client: string;
  command: string;
  status: RunStatus;
  costUsd: number;
  durationMs?: number;
  steps: RunStepSummary[];
  /** Log lines at warn level; the full text is in `mycel logs <run> --level warn`. */
  warnings: number;
}

const between = (from: string, to?: string) =>
  to ? new Date(to).getTime() - new Date(from).getTime() : undefined;

export function summarizeRun(runsDir: string, runId: string): RunSummary {
  const meta = readRunMeta(runsDir, runId);
  const cached = new Map<string, number>();
  const reused = new Map<string, string>();
  let warnings = 0;
  for (const line of readRunLog(runsDir, runId)) {
    if (line.level === "warn") warnings += 1;
    if (line.event === "step.reused" && line.step) {
      reused.set(
        line.step,
        String(line.data?.from ?? "")
          .split(/[\\/]/)
          .pop() ?? "",
      );
    }
    if (line.event === "api.call" && line.step && line.data?.cache === "hit") {
      cached.set(line.step, (cached.get(line.step) ?? 0) + 1);
    }
  }
  const total = between(meta.startedAt, meta.endedAt);
  return {
    runId: meta.runId,
    client: meta.client,
    command: meta.command,
    status: runStatus(meta),
    costUsd: meta.costUsd,
    ...(total !== undefined ? { durationMs: total } : {}),
    steps: meta.steps.map((s) => {
      const durationMs = between(s.startedAt, s.endedAt);
      return {
        name: s.name,
        status: s.status,
        ...(durationMs !== undefined ? { durationMs } : {}),
        costUsd: s.costUsd,
        llmCalls: s.llmCalls,
        apiCalls: s.apiCalls,
        cachedApiCalls: cached.get(s.name) ?? 0,
        ...(reused.has(s.name) ? { reusedFrom: reused.get(s.name) ?? "" } : {}),
      };
    }),
    warnings,
  };
}

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function duration(n: number | undefined): string {
  if (n === undefined) return "";
  if (n < 1000) return `${n}ms`;
  const s = Math.round(n / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function calls(s: RunStepSummary): string {
  const parts: string[] = [];
  if (s.llmCalls) parts.push(count(s.llmCalls, "model call"));
  if (s.apiCalls) {
    const from =
      s.cachedApiCalls === 0
        ? ""
        : s.cachedApiCalls === s.apiCalls
          ? " (all from cache)"
          : ` (${s.cachedApiCalls.toLocaleString("en-US")} from cache)`;
    parts.push(`${count(s.apiCalls, "API call")}${from}`);
  }
  return parts.join(", ");
}

const LABEL = 12;

/**
 * The short ending of a command: one line per step, then the run and where its full log is.
 * Every call is still in log.jsonl (ADR 0009); this only decides what is printed by default.
 */
export function formatRunSummary(summary: RunSummary): string[] {
  const width = Math.max(0, ...summary.steps.map((s) => s.name.length));
  const lines = summary.steps.map((s, i) => {
    const mark =
      s.status === "failed"
        ? "FAILED"
        : s.status === "interrupted"
          ? "interrupted"
          : s.status === "running"
            ? "not finished"
            : "";
    const cells = [s.name.padEnd(width), duration(s.durationMs).padStart(7), usd(s.costUsd)];
    const reuse = s.reusedFrom !== undefined ? `reused from ${s.reusedFrom}` : "";
    const tail = [calls(s), reuse, mark].filter(Boolean).join("  ");
    return `${(i === 0 ? "steps" : "").padEnd(LABEL)}${cells.join("  ")}${tail ? `  ${tail}` : ""}`;
  });
  if (summary.warnings) {
    lines.push(
      `${"warnings".padEnd(LABEL)}${summary.warnings} (mycel logs ${summary.runId} --level warn)`,
    );
  }
  lines.push(
    `${"run".padEnd(LABEL)}${summary.runId}  ${summary.status}  ${usd(summary.costUsd)}  (full log: mycel logs ${summary.runId})`,
  );
  return lines;
}
