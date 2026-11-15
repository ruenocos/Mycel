import type { SerializedError } from "./types.ts";

export function serializeError(err: unknown, depth = 0): SerializedError {
  if (err instanceof Error) {
    const out: SerializedError = { name: err.name, message: err.message };
    if (err.stack) out.stack = err.stack;
    if (err.cause !== undefined && depth < 5) out.cause = serializeError(err.cause, depth + 1);
    return out;
  }
  return { name: "NonError", message: typeof err === "string" ? err : JSON.stringify(err) };
}

/**
 * What went wrong, as a caller can act on it. The code decides the exit code of the CLI and, with
 * `transient`, whether running the same command again can help (issue #43).
 */
export const ERROR_CODES = [
  /** A flag or argument is wrong. */
  "USAGE",
  /** An input file isn't there. */
  "INPUT_MISSING",
  /** An input file is there but isn't what the command needs. */
  "INPUT_INVALID",
  /** The context exists but nobody confirmed it. */
  "NOT_CONFIRMED",
  /** The command would replace a file a person confirmed or reviewed. */
  "WOULD_REPLACE",
  /** No run with that id. */
  "RUN_NOT_FOUND",
  /** A key or login isn't set. */
  "KEY_MISSING",
  /** The service refused the key. */
  "AUTH_REFUSED",
  /** The run budget or the monthly ceiling is reached. */
  "BUDGET_EXCEEDED",
  /** The command needs a paid call and paid calls aren't switched on. */
  "PAID_CALLS_OFF",
  /** The run worked, but a quality gate or eval is below its pass mark. */
  "BELOW_PASS_MARK",
  /** Network trouble or a rate limit: the same command can work a moment later. */
  "TEMPORARY",
  /** A step failed. */
  "RUN_FAILED",
  /** Anything nobody classified. */
  "UNEXPECTED",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorInfo {
  code: ErrorCode;
  /** What went wrong, with the file, run or value it is about. */
  message: string;
  /** What to do about it: a command to run or a setting to change. */
  fix?: string;
  /** True when running the same command again can succeed. */
  transient: boolean;
}

/** An error that already knows its code and its fix. Throw this instead of a bare Error where a fix exists. */
export class MycelError extends Error implements ErrorInfo {
  override name = "MycelError";
  readonly code: ErrorCode;
  readonly fix?: string;
  readonly transient: boolean;
  constructor(
    code: ErrorCode,
    message: string,
    opts: { fix?: string; transient?: boolean; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.code = code;
    if (opts.fix) this.fix = opts.fix;
    this.transient = opts.transient ?? code === "TEMPORARY";
  }
}
