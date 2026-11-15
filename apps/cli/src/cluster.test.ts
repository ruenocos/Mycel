import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  it("--dry-run counts what the run would buy, without a login, a run or a file", async () => {
    const dir = tmp();
    const context = JSON.parse(readFileSync(join(fixture("plantpost"), "context.json"), "utf8"));
    writeFileSync(join(dir, "context.json"), JSON.stringify(context));
    writeFileSync(
      join(dir, "queries.json"),
      JSON.stringify({
        site: context.site,
        market: context.market,
        stats: { total: 4, kept: 3, dropped: {} },
        queries: [
          query("kamerplant kopen", 900),
          query("kamerplanten kopen", 300),
          query("monstera"),
          { ...query("gratis plaatjes"), filter: { kept: false, reason: "noise" } },
        ],
      }),
    );
    const res = await clusterRun({
      runsDir: join(dir, "runs"),
      queriesFile: join(dir, "queries.json"),
      cacheDir: join(dir, "cache"),
      allowUnconfirmed: true,
      dryRun: true,
      // No DataforSEO login, and no port: a dry run needs neither.
      env: {},
    });
    expect(res.ok).toBe(true);
    expect(res.runId).toBeUndefined();
    const text = res.lines.join("\n");
    expect(text).toContain("nothing is bought and no file is written");
    expect(text).toContain("SERPs       3 needed, one per kept query");
    expect(text).toContain("3 to buy");
    expect(text).toContain("cost        about $0.0018 (3 x $0.0006, the list price");
    expect(text).toContain("budget      fits --budget 3; this month $0.00 of $50");
    expect(res.next?.[0]?.note).toBe(
      "the same command without --dry-run, plus --live-serp --budget 3 to buy what is missing",
    );
    // Nothing happened on disk: no run, no output, not even a cache folder.
    for (const path of ["runs", "clusters.json", "cache"]) {
      expect(existsSync(join(dir, path)), path).toBe(false);
    }

    // A budget below the estimate is said up front, with the amount that covers it.
    const tight = await clusterRun({
      runsDir: join(dir, "runs"),
      queriesFile: join(dir, "queries.json"),
      cacheDir: join(dir, "cache"),
      allowUnconfirmed: true,
      dryRun: true,
      budgetUsd: 0.001,
      env: {},
    });
    expect(tight.lines.join("\n")).toContain(
      "over --budget 0.001: the run would stop early. All of it needs --budget 0.01",
    );
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
