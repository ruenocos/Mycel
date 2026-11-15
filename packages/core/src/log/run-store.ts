import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeError } from "./errors.ts";
import {
  appendJsonLine,
  consoleSink,
  fileSink,
  Logger,
  type LogSink,
  multiSink,
} from "./logger.ts";
import { redact, secretsFromEnv } from "./redact.ts";
import type { ApiCallRecord, LlmCallRecord, LogLevel, RunMeta, StepSummary } from "./types.ts";

export interface CreateRunOptions {
  runsDir: string;
  client: string;
  command: string;
  cliVersion: string;
  config?: Record<string, unknown>;
  /** Extra secret values to scrub; env secrets are always included. */
  secrets?: string[];
  /** Mirror logs to the console from this level (e.g. "debug" with --debug). Off when undefined. */
  consoleLevel?: LogLevel;
  /** Extra sink, e.g. memorySink() in tests. */
  sink?: LogSink;
  /** Override for tests. */
  now?: () => Date;
}

export interface StepContext {
  readonly runId: string;
  readonly step: string;
  readonly dir: string;
  readonly log: Logger;
  /** Saves the full record to runs/<id>/<step>/llm/<callId>.json and logs a summary line. */
  recordLlmCall(
    rec: Omit<LlmCallRecord, "runId" | "step" | "callId"> & { callId?: string },
  ): string;
  /** Appends to runs/<id>/<step>/api.jsonl and logs a summary line. */
  recordApiCall(
    rec: Omit<ApiCallRecord, "runId" | "step" | "callId"> & { callId?: string },
  ): string;
}

let progress: ((line: string) => void) | undefined;

/**
 * Where a run says which step it starts, while it is busy. The CLI points this at stderr so a long
 * run isn't silent; off by default (tests, libraries). A run that mirrors its log to the console
 * (--debug) already shows every step, so it stays quiet here.
 */
export function setRunProgress(sink: ((line: string) => void) | undefined): void {
  progress = sink;
}

/** Runs that are busy in this process, so a signal handler can mark them before the exit. */
const active = new Set<RunStore>();

/**
 * Marks every run that is still busy as "interrupted" and returns them. For the CLI's SIGINT and
 * SIGTERM handlers: without it a stopped run would say "running" for ever. Sync on purpose, a
 * signal handler has no time to wait.
 */
export function interruptActiveRuns(signal: string): RunMeta[] {
  return [...active].map((run) => run.interrupt(signal));
}

export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
  return `${stamp}Z-${randomBytes(2).toString("hex")}`;
}

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null; // not a git checkout (e.g. installed package); recorded as null on purpose
  }
}

const RENAME_RETRIES = 6;
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * On Windows a file another program has open (a log viewer, antivirus, the search indexer) can't
 * be replaced for a moment: the rename is retried a few times before the error is passed on.
 */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= RENAME_RETRIES || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw err;
      sleepSync(25 * 2 ** i);
    }
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** One run on disk: runs/<run-id>/{run.json, log.jsonl, <step>/...} (ADR 0009). */
export class RunStore {
  readonly runId: string;
  readonly dir: string;
  readonly log: Logger;
  private readonly meta: RunMeta;
  private readonly secrets: string[];
  private readonly now: () => Date;
  private readonly quiet: boolean;
  private seq = 0;

  private constructor(opts: CreateRunOptions) {
    this.now = opts.now ?? (() => new Date());
    this.runId = newRunId(this.now());
    this.dir = join(opts.runsDir, this.runId);
    mkdirSync(this.dir, { recursive: true });
    this.secrets = [...secretsFromEnv(), ...(opts.secrets ?? [])];
    this.quiet = opts.consoleLevel !== undefined;
    const sinks: LogSink[] = [fileSink(join(this.dir, "log.jsonl"))];
    if (opts.consoleLevel) sinks.push(consoleSink(opts.consoleLevel));
    if (opts.sink) sinks.push(opts.sink);
    this.log = new Logger(multiSink(...sinks), this.runId, undefined, this.secrets);
    this.meta = {
      runId: this.runId,
      client: opts.client,
      command: opts.command,
      config: redact(opts.config ?? {}, this.secrets),
      gitCommit: gitCommit(),
      cliVersion: opts.cliVersion,
      startedAt: this.now().toISOString(),
      status: "running",
      pid: process.pid,
      costUsd: 0,
      steps: [],
    };
    this.save();
    active.add(this);
    this.log.event("info", "run.start", `run started: ${opts.command} for ${opts.client}`, {
      gitCommit: this.meta.gitCommit,
      cliVersion: opts.cliVersion,
    });
  }

  static create(opts: CreateRunOptions): RunStore {
    return new RunStore(opts);
  }

  get summary(): Readonly<RunMeta> {
    return this.meta;
  }

  /** Runs fn as a named step. Records status, cost and errors, then rethrows on failure. */
  async step<T>(name: string, fn: (ctx: StepContext) => Promise<T>): Promise<T> {
    const summary: StepSummary = {
      name,
      status: "running",
      startedAt: this.now().toISOString(),
      costUsd: 0,
      llmCalls: 0,
      apiCalls: 0,
    };
    this.meta.steps.push(summary);
    this.save();
    const dir = join(this.dir, name);
    mkdirSync(dir, { recursive: true });
    const log = this.log.child(name);
    log.event("info", "step.start", `step ${name} started`);
    if (!this.quiet) progress?.(`running     ${name}`);
    const started = this.now().getTime();
    try {
      const result = await fn(this.stepContext(name, dir, log, summary));
      summary.status = "ok";
      summary.endedAt = this.now().toISOString();
      this.save();
      log.event("info", "step.ok", `step ${name} ok`, {
        durationMs: this.now().getTime() - started,
        costUsd: summary.costUsd,
      });
      return result;
    } catch (err) {
      summary.status = "failed";
      summary.endedAt = this.now().toISOString();
      summary.error = redact(serializeError(err), this.secrets);
      this.save();
      log.event(
        "error",
        "step.failed",
        `step ${name} failed`,
        { durationMs: this.now().getTime() - started, costUsd: summary.costUsd },
        err,
      );
      throw err;
    }
  }

  /** Marks the run finished. Pass the error when the run failed. */
  finish(err?: unknown): RunMeta {
    this.meta.endedAt = this.now().toISOString();
    const failed = err !== undefined || this.meta.steps.some((s) => s.status === "failed");
    this.meta.status = failed ? "failed" : "ok";
    if (err !== undefined) this.meta.error = redact(serializeError(err), this.secrets);
    this.save();
    active.delete(this);
    this.log.event(
      failed ? "error" : "info",
      "run.end",
      `run ${this.meta.status}`,
      { costUsd: this.meta.costUsd, steps: this.meta.steps.length },
      err,
    );
    return this.meta;
  }

  /** Stopped from outside while busy: say so on disk. What was paid for stays in the cache. */
  interrupt(signal: string): RunMeta {
    const at = this.now().toISOString();
    this.meta.endedAt = at;
    this.meta.status = "interrupted";
    for (const step of this.meta.steps) {
      if (step.status !== "running") continue;
      step.status = "interrupted";
      step.endedAt = at;
    }
    this.save();
    active.delete(this);
    this.log.event("warn", "run.interrupted", `run interrupted (${signal})`, {
      costUsd: this.meta.costUsd,
      steps: this.meta.steps.length,
    });
    return this.meta;
  }

  private nextCallId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(4, "0")}`;
  }

  private addCost(summary: StepSummary, usd: number | undefined): void {
    if (!usd) return;
    summary.costUsd = round(summary.costUsd + usd);
    this.meta.costUsd = round(this.meta.costUsd + usd);
  }

  private stepContext(name: string, dir: string, log: Logger, summary: StepSummary): StepContext {
    return {
      runId: this.runId,
      step: name,
      dir,
      log,
      recordLlmCall: (rec) => {
        const callId = rec.callId ?? this.nextCallId("llm");
        const full: LlmCallRecord = { ...rec, callId, runId: this.runId, step: name };
        const llmDir = join(dir, "llm");
        mkdirSync(llmDir, { recursive: true });
        writeJsonAtomic(join(llmDir, `${callId}.json`), redact(full, this.secrets));
        summary.llmCalls += 1;
        this.addCost(summary, rec.costUsd);
        this.save();
        log.event(rec.status === "ok" ? "info" : "error", "llm.call", `llm ${rec.status}`, {
          callId,
          provider: rec.provider,
          model: rec.model,
          modelDigest: rec.modelDigest,
          promptTemplate: `${rec.promptTemplate.id}@${rec.promptTemplate.version}`,
          inputTokens: rec.usage?.inputTokens,
          outputTokens: rec.usage?.outputTokens,
          latencyMs: rec.latencyMs,
          costUsd: rec.costUsd,
          attempt: rec.attempt,
          file: `${name}/llm/${callId}.json`,
          ...(rec.error ? { error: rec.error.message } : {}),
        });
        return callId;
      },
      recordApiCall: (rec) => {
        const callId = rec.callId ?? this.nextCallId("api");
        const full: ApiCallRecord = { ...rec, callId, runId: this.runId, step: name };
        appendJsonLine(join(dir, "api.jsonl"), redact(full, this.secrets));
        summary.apiCalls += 1;
        this.addCost(summary, rec.costUsd);
        this.save();
        const ok = rec.status !== "error" && rec.status < 400;
        log.event(ok ? "info" : "error", "api.call", `${rec.service} ${rec.endpoint}`, {
          callId,
          cache: rec.cache,
          status: rec.status,
          latencyMs: rec.latencyMs,
          costUsd: rec.costUsd,
          ...(rec.error ? { error: rec.error.message } : {}),
        });
        return callId;
      },
    };
  }

  private save(): void {
    writeJsonAtomic(join(this.dir, "run.json"), this.meta);
  }
}
