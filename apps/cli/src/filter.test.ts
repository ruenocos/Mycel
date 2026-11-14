import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilteredQueries } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import { filterEval, filterRun } from "./filter.ts";

const fixture = (name: string) => join(import.meta.dirname, "../../../fixtures/clients", name);
const tmp = () => mkdtempSync(join(tmpdir(), "mycel-cli-filter-"));

describe("mycel filter", () => {
  it("filters a research file next to its context with the fake model", async () => {
    const dir = tmp();
    const context = JSON.parse(readFileSync(join(fixture("plantpost"), "context.json"), "utf8"));
    writeFileSync(join(dir, "context.json"), JSON.stringify(context));
    const query = (text: string, volume?: number) => ({
      text,
      normalized: text,
      sources: ["dfs_related"],
      metrics: volume ? { volume } : {},
    });
    writeFileSync(
      join(dir, "research.json"),
      JSON.stringify({
        site: context.site,
        market: context.market,
        seeds: [{ text: "kamerplant", normalized: "kamerplant", basis: "entity" }],
        queries: [
          query("kamerplant kopen", 900),
          query("tuinplant kopen", 400),
          query("plantpost"),
        ],
        serps: [],
        competitors: [],
        pages: [],
        coverage: [],
        warnings: [],
      }),
    );
    const res = await filterRun({
      runsDir: join(dir, "runs"),
      researchFile: join(dir, "research.json"),
      provider: "fake",
      model: "m",
      allowUnconfirmed: true,
      env: {},
    });
    expect(res.ok).toBe(true);
    const d = FilteredQueries.parse(JSON.parse(readFileSync(join(dir, "queries.json"), "utf8")));
    expect(d.stats).toEqual({ total: 3, kept: 1, dropped: { "not this": 1, "own brand": 1 } });
    expect(res.lines.join("\n")).toContain("top         kamerplant kopen");
  });
});

describe("mycel eval filter", () => {
  const run = (minAccuracy?: number) =>
    filterEval({
      runsDir: join(tmp(), "runs"),
      fixtures: [fixture("plantpost"), fixture("praktijk-beweegruimte")],
      provider: "fake",
      model: "m",
      env: {},
      ...(minAccuracy !== undefined ? { minAccuracy } : {}),
    });

  it("scores the tuning and the held-out set of both test clients", async () => {
    // The fake model keeps everything the rules let through, so only recall is perfect.
    const res = await run(0);
    expect(res.ok).toBe(true);
    expect(res.scores.map((s) => [s.client, s.set])).toEqual([
      ["plantpost", "tuning"],
      ["plantpost", "held-out"],
      ["praktijk-beweegruimte", "tuning"],
      ["praktijk-beweegruimte", "held-out"],
    ]);
    expect(res.scores.every((s) => s.recall === 1 && s.passed)).toBe(true);
  });

  it("fails below the pass mark instead of passing at any score", async () => {
    const res = await run();
    expect(res.ok).toBe(false);
    expect(res.scores.every((s) => s.accuracy < 0.9 && !s.passed)).toBe(true);
    const text = res.lines.join("\n");
    expect(text).toContain("held-out FAIL  accuracy");
    expect(text).toContain("(needs 0.9)");
    expect(text).toContain("never fit them to the held-out misses");
    await expect(run(Number("high"))).rejects.toThrow("--min-accuracy must be between 0 and 1");
  });
});
