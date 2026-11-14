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
  it("scores both test clients (fake model keeps everything the rules let through)", async () => {
    const res = await filterEval({
      runsDir: join(tmp(), "runs"),
      fixtures: [fixture("plantpost"), fixture("praktijk-beweegruimte")],
      provider: "fake",
      model: "m",
      env: {},
    });
    expect(res.ok).toBe(true);
    expect(res.scores.map((s) => s.client)).toEqual(["plantpost", "praktijk-beweegruimte"]);
    expect(res.scores[0]?.recall).toBe(1);
  });
});
