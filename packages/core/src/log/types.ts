export type LogLevel = "debug" | "info" | "warn" | "error";

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedError;
}

/** One line in runs/<run-id>/log.jsonl. */
export interface LogLine {
  ts: string;
  level: LogLevel;
  runId: string;
  step?: string;
  /** Machine-readable kind, used by the timeline: step.start, step.ok, step.failed, llm.call, api.call, run.start, run.end */
  event?: string;
  msg: string;
  data?: Record<string, unknown>;
  err?: SerializedError;
}

/** Everything needed to explain an LLM output weeks later (ADR 0009). */
export interface LlmCallRecord {
  callId: string;
  runId: string;
  step: string;
  provider: string;
  endpoint: string;
  /** Model name as requested. */
  model: string;
  /** Exact version as reported by the provider (Ollama digest), if available. */
  modelDigest?: string;
  /** temperature, top_p, seed, max tokens, format, ... */
  params: Record<string, unknown>;
  promptTemplate: { id: string; version: string };
  promptHash: string;
  /** Full request body (messages etc). Secrets are redacted before writing. */
  request: unknown;
  /** Full raw response body. */
  response?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Provider timings, e.g. Ollama total_duration, load_duration, prompt_eval_count, eval_count, done_reason. */
  providerTimings?: Record<string, number | string>;
  costUsd?: number;
  latencyMs: number;
  attempt: number;
  status: "ok" | "error";
  error?: SerializedError;
  startedAt: string;
}

/** A paid or external API call (DataforSEO, GSC, ...). */
export interface ApiCallRecord {
  callId: string;
  runId: string;
  step: string;
  service: string;
  endpoint: string;
  requestHash: string;
  cache: "hit" | "miss" | "bypass";
  costUsd: number;
  latencyMs: number;
  status: number | "error";
  error?: SerializedError;
  startedAt: string;
}

/** "interrupted": the run was stopped (Ctrl+C, a kill signal) while this step was busy. */
export type StepStatus = "running" | "ok" | "failed" | "interrupted";

export interface StepSummary {
  name: string;
  status: StepStatus;
  startedAt: string;
  endedAt?: string;
  costUsd: number;
  llmCalls: number;
  apiCalls: number;
  error?: SerializedError;
}

/** runs/<run-id>/run.json */
export interface RunMeta {
  runId: string;
  client: string;
  command: string;
  config: Record<string, unknown>;
  gitCommit: string | null;
  cliVersion: string;
  startedAt: string;
  endedAt?: string;
  /**
   * "interrupted": stopped by a signal, and the run could still write that down. A run whose
   * process died without a word (power off, a forced kill) stays "running" on disk; readers
   * use `runStatus()` to show it as "stopped".
   */
  status: "running" | "ok" | "failed" | "interrupted";
  /** The process that runs (or ran) it, so a reader can tell a live run from a dead one. */
  pid?: number;
  costUsd: number;
  steps: StepSummary[];
  error?: SerializedError;
}

/** What a reader shows: the status on disk, or "stopped" for a run whose process is gone. */
export type RunStatus = RunMeta["status"] | "stopped";
