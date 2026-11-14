import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contextPropose } from "./context.ts";
import {
  costLine,
  DEFAULT_MONTHLY_BUDGET_USD,
  dataforseoFromEnv,
  monthlyBudget,
  runBudget,
} from "./dataforseo.ts";
import { research } from "./research.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "mycel-cli-dfs-"));
const fixture = (name: string) => join(import.meta.dirname, "../../../fixtures/clients", name);

describe("DataforSEO budgets in the CLI", () => {
  it("only takes a real, positive run budget", () => {
    expect(runBudget(undefined, 1)).toBe(1);
    expect(runBudget(2.5, 1)).toBe(2.5);
    expect(() => runBudget(Number("abc"), 1)).toThrow("--budget must be a positive number");
    expect(() => runBudget(0, 1)).toThrow("--budget must be a positive number");
  });

  it("reads the monthly ceiling from the environment, with the ADR 0004 default", () => {
    expect(monthlyBudget({})).toBe(DEFAULT_MONTHLY_BUDGET_USD);
    expect(monthlyBudget({ DATAFORSEO_MONTHLY_BUDGET_USD: " 20 " })).toBe(20);
    expect(() => monthlyBudget({ DATAFORSEO_MONTHLY_BUDGET_USD: "veel" })).toThrow(
      "DATAFORSEO_MONTHLY_BUDGET_USD",
    );
  });

  it("builds a client only when the login is set, and shows the month in the cost line", () => {
    const cacheDir = tmp();
    expect(dataforseoFromEnv({}, { cacheDir, budgetUsd: 1 })).toBeUndefined();
    const env = { DATAFORSEO_LOGIN: "user@example.com", DATAFORSEO_PASSWORD: "pw" };
    const dfs = dataforseoFromEnv(env, { cacheDir, budgetUsd: 1 });
    expect(dfs).toBeDefined();
    if (dfs) {
      expect(costLine(dfs, 1, env)).toBe(
        "cost        $0.0000 DataforSEO (budget $1; this month $0.00 of $50)",
      );
    }
  });

  it("stops research and context propose on a --budget that isn't a number", async () => {
    const dir = tmp();
    await expect(
      research({
        runsDir: join(dir, "runs"),
        contextFile: join(fixture("plantpost"), "context.json"),
        provider: "fake",
        model: "m",
        budgetUsd: Number("abc"),
        env: {},
      }),
    ).rejects.toThrow("--budget must be a positive number");
    await expect(
      contextPropose({
        runsDir: join(dir, "runs"),
        site: fixture("plantpost"),
        market: "NL / nl",
        out: join(dir, "c.json"),
        provider: "fake",
        model: "m",
        budgetUsd: Number.NaN,
        env: {},
      }),
    ).rejects.toThrow("--budget must be a positive number");
  });
});
