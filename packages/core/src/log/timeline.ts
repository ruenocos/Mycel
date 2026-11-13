import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LogLevel, LogLine, RunMeta } from "./types.ts";

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
  if (idOrPrefix === "latest") {
    const latest = runs[0];
    if (!latest) throw new Error(`no runs in ${runsDir}`);
    return latest.runId;
  }
  const matches = runs.filter((r) => r.runId.startsWith(idOrPrefix));
  const only = matches[0];
  if (matches.length === 1 && only) return only.runId;
  if (matches.length === 0) throw new Error(`no run matches "${idOrPrefix}" in ${runsDir}`);
  throw new Error(`"${idOrPrefix}" matches ${matches.length} runs, be more specific`);
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
    `  client ${meta.client} · command ${meta.command} · status ${meta.status} · cost ${usd(meta.costUsd)} · git ${meta.gitCommit ?? "none"}`,
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
  return out.join("\n");
}
