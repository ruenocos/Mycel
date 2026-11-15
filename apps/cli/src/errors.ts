import {
  BudgetExceededError,
  DataforseoError,
  GscError,
  LiveCallBlockedError,
  LlmOutputError,
  LlmProviderError,
  WordPressError,
} from "@mycel/connectors";
import { type ErrorCode, type ErrorInfo, MycelError, StepValidationError } from "@mycel/core";
import { ZodError } from "zod";

/**
 * Turns any error into what a caller can act on: a code, a message, a fix and whether a retry can
 * help (issue #43). The connectors already say whether a failure is retryable; this is the one
 * place that reads it, so core and connectors don't need to know about exit codes.
 */

/** Exit code per error code. Documented in `mycel --help`; add codes, never change one. */
export const EXIT_CODES: Record<ErrorCode, number> = {
  RUN_FAILED: 1,
  UNEXPECTED: 1,
  USAGE: 2,
  INPUT_MISSING: 3,
  INPUT_INVALID: 3,
  NOT_CONFIRMED: 3,
  RUN_NOT_FOUND: 3,
  KEY_MISSING: 4,
  WOULD_REPLACE: 5,
  AUTH_REFUSED: 4,
  BELOW_PASS_MARK: 10,
  BUDGET_EXCEEDED: 11,
  PAID_CALLS_OFF: 11,
  TEMPORARY: 75,
};

const RETRY = "run the same command again";
const refused = (status: unknown) => status === 401 || status === 403;

/** "missing: site, market; clusters: expected array" instead of the validator's raw JSON. */
export function describeIssues(err: ZodError, max = 4): string {
  const missing: string[] = [];
  const wrong: string[] = [];
  for (const issue of err.issues) {
    const path = issue.path.join(".") || "(the file itself)";
    if (issue.code === "invalid_type" && issue.message.endsWith("received undefined")) {
      missing.push(path);
    } else {
      wrong.push(`${path}: ${issue.message.replace(/^Invalid input: /, "")}`);
    }
  }
  const short = (list: string[], sep: string) =>
    list.length > max
      ? `${list.slice(0, max).join(sep)}${sep}and ${list.length - max} more`
      : list.join(sep);
  return [missing.length ? `missing ${short(missing, ", ")}` : "", short(wrong, "; ")]
    .filter(Boolean)
    .join("; ");
}

function service(
  name: string,
  err: { message: string; retryable: boolean },
  status: unknown,
  cached: boolean,
): ErrorInfo {
  if (refused(status)) {
    return {
      code: "AUTH_REFUSED",
      message: `${name} refused the key: ${err.message}`,
      fix: "check the key in .env (.env.example lists them)",
      transient: false,
    };
  }
  if (err.retryable) {
    return {
      code: "TEMPORARY",
      message: `${name}: ${err.message}`,
      fix: cached ? `${RETRY}; calls that already went through are cached` : RETRY,
      transient: true,
    };
  }
  return { code: "RUN_FAILED", message: `${name}: ${err.message}`, transient: false };
}

export function describeError(err: unknown): ErrorInfo {
  if (err instanceof MycelError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.fix ? { fix: err.fix } : {}),
      transient: err.transient,
    };
  }
  if (err instanceof BudgetExceededError) {
    return {
      code: "BUDGET_EXCEEDED",
      message: err.message,
      fix: "raise --budget (or DATAFORSEO_MONTHLY_BUDGET_USD for the monthly ceiling) and run again; what was paid for is cached",
      transient: false,
    };
  }
  if (err instanceof LiveCallBlockedError) {
    return {
      code: "PAID_CALLS_OFF",
      message: err.message,
      fix: "add --live-serp (with a --budget) to allow paid SERP calls",
      transient: false,
    };
  }
  if (err instanceof DataforseoError) return service("DataforSEO", err, err.statusCode, true);
  if (err instanceof GscError) return service("Search Console", err, err.status, false);
  if (err instanceof LlmProviderError) return service(err.provider, err, err.status, false);
  if (err instanceof WordPressError) {
    const retryable = err.status === "error";
    return service("the site", { message: err.message, retryable }, err.status, true);
  }
  if (err instanceof LlmOutputError) {
    return {
      code: "RUN_FAILED",
      message: err.message,
      fix: "the model's answers are saved with the run; read them in the log",
      transient: false,
    };
  }
  if (err instanceof StepValidationError) {
    return {
      code: "RUN_FAILED",
      message: `${err.step}: ${err.side} failed validation (${err.details.split("\n").length} problems; they are in the log)`,
      transient: false,
    };
  }
  if (err instanceof ZodError) {
    return { code: "INPUT_INVALID", message: describeIssues(err), transient: false };
  }
  if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return { code: "INPUT_MISSING", message: (err as Error).message, transient: false };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "UNEXPECTED", message, transient: false };
}
