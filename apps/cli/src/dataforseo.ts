import { join } from "node:path";
import { DataforseoClient } from "@mycel/connectors";
import { MycelError } from "@mycel/core";

/**
 * One place where the CLI builds its DataforSEO client, so every command gets the same budget
 * rules: a per-run budget that must be a real number, and a monthly ceiling across runs.
 */

/** ADR 0004: under EUR 50 a month while testing. Change it with DATAFORSEO_MONTHLY_BUDGET_USD. */
export const DEFAULT_MONTHLY_BUDGET_USD = 50;

/** The fix for keys that aren't set. */
export const KEYS_FIX = "set them in .env (.env.example lists every key)";
export const KEY_FIX = "set it in .env (.env.example lists every key)";

const positive = (n: number) => Number.isFinite(n) && n > 0;

/** `--budget abc` becomes NaN, and a NaN cap never triggers. Stop before any paid call. */
export function runBudget(value: number | undefined, fallback: number): number {
  const budget = value ?? fallback;
  if (!positive(budget)) {
    throw new MycelError("USAGE", `--budget must be a positive number of dollars, got ${value}`);
  }
  return budget;
}

export function monthlyBudget(env: NodeJS.ProcessEnv): number {
  const raw = env.DATAFORSEO_MONTHLY_BUDGET_USD?.trim();
  if (!raw) return DEFAULT_MONTHLY_BUDGET_USD;
  if (!positive(Number(raw))) {
    throw new MycelError(
      "USAGE",
      `DATAFORSEO_MONTHLY_BUDGET_USD must be a positive number of dollars, got "${raw}"`,
      { fix: "correct it in .env" },
    );
  }
  return Number(raw);
}

/** Undefined when the login isn't set; the caller decides whether that is an error. */
export function dataforseoFromEnv(
  env: NodeJS.ProcessEnv,
  opts: { cacheDir: string; budgetUsd: number; allowLiveSerp?: boolean },
): DataforseoClient | undefined {
  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) return undefined;
  return new DataforseoClient({
    login: env.DATAFORSEO_LOGIN,
    password: env.DATAFORSEO_PASSWORD,
    cacheDir: join(opts.cacheDir, "dataforseo"),
    budgetUsd: opts.budgetUsd,
    monthlyBudgetUsd: monthlyBudget(env),
    allowLiveSerp: !!opts.allowLiveSerp,
  });
}

export function costLine(dfs: DataforseoClient, budgetUsd: number, env: NodeJS.ProcessEnv): string {
  const month = `this month $${dfs.spentThisMonthUsd.toFixed(2)} of $${monthlyBudget(env)}`;
  return `cost        $${dfs.spentUsd.toFixed(4)} DataforSEO (budget $${budgetUsd}; ${month})`;
}
