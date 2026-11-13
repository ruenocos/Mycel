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
