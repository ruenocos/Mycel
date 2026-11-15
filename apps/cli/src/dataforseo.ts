import { join } from "node:path";
import { DataforseoClient, type SerpPlan } from "@mycel/connectors";
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

export const DRY_RUN = "dry run     nothing is bought and no file is written";

const n = (count: number) => count.toLocaleString("en-US");
/** Rounded up to a cent: a budget that is a hair too low stops the run one batch early. */
const cents = (usd: number) => Math.max(0.01, Math.ceil(usd * 100) / 100);

export function budgetLine(estimateUsd: number, budgetUsd: number, monthUsd: number, cap: number) {
  const month = `this month $${monthUsd.toFixed(2)} of $${cap}`;
  if (monthUsd + estimateUsd > cap) {
    return `budget      over the month's ceiling: ${month}, and this needs about $${estimateUsd.toFixed(2)} more`;
  }
  if (estimateUsd > budgetUsd) {
    return `budget      over --budget ${budgetUsd}: the run would stop early. All of it needs --budget ${cents(estimateUsd)} (${month})`;
  }
  return `budget      fits --budget ${budgetUsd}; ${month}`;
}

/** What `--dry-run` prints for a batch of SERPs: counts first, then money, then the budget. */
export function serpPlanLines(
  plan: SerpPlan,
  budgetUsd: number,
  env: NodeJS.ProcessEnv,
  what: string,
): string[] {
  const lines = [DRY_RUN, `SERPs       ${n(plan.total)} needed, ${what}`];
  if (!plan.exact) {
    lines.push(
      "            the city's location code is not in the cache yet, so none can be matched:",
      `            all ${n(plan.total)} count as to buy (the real number can only be lower)`,
    );
  } else {
    lines.push(`            ${n(plan.cached)} in cache`);
    if (plan.waiting) {
      lines.push(`            ${n(plan.waiting)} paid by an earlier run, collected for free`);
    }
    lines.push(`            ${n(plan.toBuy)} to buy`);
  }
  if (plan.toBuy === 0) {
    lines.push("cost        $0.0000: nothing to buy");
    return lines;
  }
  const price =
    plan.priceSource === "paid before"
      ? "the price of the last SERP bought"
      : "the list price, nothing bought through this cache yet";
  lines.push(
    `cost        about $${plan.estimateUsd.toFixed(4)} (${n(plan.toBuy)} x $${plan.priceUsd}, ${price})`,
    budgetLine(plan.estimateUsd, budgetUsd, plan.spentThisMonthUsd, monthlyBudget(env)),
  );
  return lines;
}
