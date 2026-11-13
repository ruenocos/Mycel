/**
 * What connectors need from a run to log their calls (ADR 0009).
 * Core's StepContext satisfies this structurally, so connectors don't depend on core.
 */
export interface ApiCallInput {
  service: string;
  endpoint: string;
  requestHash: string;
  cache: "hit" | "miss" | "bypass";
  costUsd: number;
  latencyMs: number;
  status: number | "error";
  error?: { name: string; message: string; stack?: string };
  startedAt: string;
}

/** Mirrors core's LlmCallRecord minus run/step/callId (ADR 0009). */
export interface LlmCallInput {
  provider: string;
  endpoint: string;
  model: string;
  modelDigest?: string;
  params: Record<string, unknown>;
  promptTemplate: { id: string; version: string };
  promptHash: string;
  request: unknown;
  response?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  providerTimings?: Record<string, number | string>;
  costUsd?: number;
  latencyMs: number;
  attempt: number;
  status: "ok" | "error";
  error?: { name: string; message: string; stack?: string };
  startedAt: string;
}

export interface LlmRecorder {
  recordLlmCall(rec: LlmCallInput): string;
  log: CallRecorder["log"];
}

export interface CallRecorder {
  recordApiCall(rec: ApiCallInput): string;
  log: {
    debug(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
  };
}

/** For scripts and tests that don't run inside a step. */
export const nullRecorder: CallRecorder = {
  recordApiCall: () => "",
  log: { debug: () => {}, warn: () => {} },
};
