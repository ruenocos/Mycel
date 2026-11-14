import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClusterSerp, SerpBatchPort } from "@mycel/core";
import { ClusterSet } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import { clusterRun } from "./cluster.ts";

const fixture = (name: string) => join(import.meta.dirname, "../../../fixtures/clients", name);
const tmp = () => mkdtempSync(join(tmpdir(), "mycel-cli-cluster-"));

const serp = (keyword: string, ids: string[]): ClusterSerp => ({
  keyword,
  organic: ids.map((u, i) => ({
    rank: i + 1,
    key: `site${u}.example/page`,
    urlSource: "url" as const,
    domain: `site${u}.example`,
  })),
  aiOverview: { present: false, references: [] },
  itemTypes: ["organic"],
});

const query = (text: string, volume?: number) => ({
  text,
  normalized: text,
  sources: ["dfs_related"],
  metrics: volume ? { volume } : {},
  label: "core",
  entity: "kamerplant",
  filter: { kept: true },
  scores: { relevance: 1, prominence: 0.5, popularity: 0.5 },
});

describe("mycel cluster", () => {
  it("clusters a queries file next to its context with a stub SERP port", async () => {
    const dir = tmp();
    const context = JSON.parse(readFileSync(join(fixture("plantpost"), "context.json"), "utf8"));
    writeFileSync(join(dir, "context.json"), JSON.stringify(context));
    writeFileSync(
      join(dir, "queries.json"),
      JSON.stringify({
        site: context.site,
        market: context.market,
        stats: { total: 3, kept: 3, dropped: {} },
        queries: [
          query("kamerplant kopen", 900),
          query("kamerplanten kopen", 300),
          query("monstera"),
        ],
      }),
    );
    const port: SerpBatchPort = {
      async serpOrganicBatch(keywords) {
        const serps = new Map<string, ClusterSerp>();
        if (keywords.includes("kamerplant kopen")) {
          serps.set("kamerplant kopen", serp("kamerplant kopen", ["1", "2", "3", "4", "5"]));
          serps.set("kamerplanten kopen", serp("kamerplanten kopen", ["1", "2", "3", "6", "7"]));
        }
        return { serps, blocked: [], failed: [{ keyword: "monstera", error: "40501" }] };
      },
    };
    const res = await clusterRun({
      runsDir: join(dir, "runs"),
      queriesFile: join(dir, "queries.json"),
      allowUnconfirmed: true,
      env: {},
      port,
    });
    expect(res.ok).toBe(true);
    const d = ClusterSet.parse(JSON.parse(readFileSync(join(dir, "clusters.json"), "utf8")));
    expect(d.stats).toMatchObject({ queries: 3, clustered: 2, clusters: 1, pages: 1 });
    expect(d.unclustered.map((u) => u.query)).toEqual(["monstera"]);
    expect(res.lines.join("\n")).toContain("top pages   kamerplant kopen (core, 2, 1200/mo)");
  });

  it("refuses an unconfirmed context unless asked for a dry run", async () => {
    const dir = tmp();
    const context = JSON.parse(readFileSync(join(fixture("plantpost"), "context.json"), "utf8"));
    writeFileSync(join(dir, "context.json"), JSON.stringify({ ...context, confirmed: undefined }));
    writeFileSync(
      join(dir, "queries.json"),
      JSON.stringify({
        site: context.site,
        market: context.market,
        stats: { total: 1, kept: 1, dropped: {} },
        queries: [query("kamerplant kopen", 900)],
      }),
    );
    await expect(
      clusterRun({ runsDir: join(dir, "runs"), queriesFile: join(dir, "queries.json"), env: {} }),
    ).rejects.toThrow("isn't confirmed yet");
  });

  it("rejects a budget that isn't a number, so the cap can't silently turn off", async () => {
    await expect(
      clusterRun({
        runsDir: join(tmp(), "runs"),
        queriesFile: join(fixture("plantpost"), "missing.json"),
        budgetUsd: Number("abc"),
        env: {},
      }),
    ).rejects.toThrow("--budget must be a positive number");
  });
});
