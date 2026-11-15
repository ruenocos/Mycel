import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SerpBatchPort, summarizeRun } from "@mycel/core";
import { MapEval } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import { describeError } from "./errors.ts";
import { evalMapRun } from "./eval-map.ts";
import { mapRun } from "./map.ts";

const fixture = (name: string) => join(import.meta.dirname, "../../../fixtures/clients", name);

const cluster = (id: string, main: string, volume: number) => ({
  id,
  mainQuery: main,
  hub: main,
  queries: [main],
  sharedUrls: [],
  qdp: "page",
  outlier: false,
  label: "core",
  entity: "kamerplant",
  members: [
    { query: main, shared: 10, volume, scores: { relevance: 1, prominence: 0.5, popularity: 0.5 } },
  ],
  demand: { volume, gscImpressions: 0 },
  aiOverview: { present: false, cited: false },
  serpFeatures: [],
  qdpWhy: "Its own results page, so its own page.",
  outlierReasons: [],
});

/** A cache stub: two searches share three results, a third is not cached. */
const port: SerpBatchPort = {
  async serpOrganicBatch(keywords) {
    const urls: Record<string, string[]> = {
      "grote kamerplant kopen": ["a", "b", "c", "d"],
      "xxl kamerplanten": ["a", "b", "c", "e"],
    };
    const serps = new Map();
    const blocked: string[] = [];
    for (const k of keywords) {
      const u = urls[k];
      if (!u) {
        blocked.push(k);
        continue;
      }
      serps.set(k, {
        keyword: k,
        organic: u.map((key, i) => ({ rank: i + 1, key, urlSource: "url", domain: "x.nl" })),
        aiOverview: { present: false, references: [] },
      });
    }
    return { serps, blocked, failed: [] };
  },
};

describe("mycel eval map", () => {
  it("scores a map from the fake pipeline, with cached SERPs and reviewer prompts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mycel-cli-evalmap-"));
    const context = JSON.parse(readFileSync(join(fixture("plantpost"), "context.json"), "utf8"));
    writeFileSync(join(dir, "context.json"), JSON.stringify(context));
    writeFileSync(
      join(dir, "clusters.json"),
      JSON.stringify({
        site: context.site,
        market: context.market,
        minSharedUrls: 3,
        clusters: [
          cluster("grote", "grote kamerplant kopen", 1200),
          cluster("xxl", "xxl kamerplanten", 900),
          cluster("kopen", "kamerplanten kopen", 4000),
        ],
        unclustered: [],
        stats: {
          queries: 3,
          clustered: 3,
          clusters: 3,
          pages: 3,
          sections: 0,
          micro: 0,
          singletons: 3,
          outliers: 0,
          ambiguousMembers: 0,
          borderlineMembers: 0,
        },
      }),
    );
    const map = await mapRun({
      runsDir: join(dir, "runs"),
      clustersFile: join(dir, "clusters.json"),
      pagesFile: join(fixture("plantpost"), "pages.json"),
      provider: "fake",
      model: "fake",
      allowUnconfirmed: true,
    });
    expect(map.ok).toBe(true);
    const res = await evalMapRun({
      runsDir: join(dir, "runs"),
      mapFile: map.out as string,
      pagesFile: join(fixture("plantpost"), "pages.json"),
      review: true,
      port,
    });
    // The eval itself ran; the map misses a target (two pages share a results page), and that
    // is a missed mark: exit code 10, so the eval can gate a change.
    expect(res.ok).toBe(false);
    expect(describeError(res.failure)).toMatchObject({ code: "BELOW_PASS_MARK" });
    expect(describeError(res.failure).message).toMatch(/^the map misses \d of 7 targets: /);
    expect(describeError(res.failure).message).toContain("duplicateIntentPairs");
    expect(summarizeRun(join(dir, "runs"), res.runId).status).toBe("ok");
    const e = MapEval.parse(JSON.parse(readFileSync(res.out as string, "utf8")));
    expect(e.metrics.duplicateIntentPairs.value).toBe(1);
    expect(e.metrics.existingWithJob.of).toBeGreaterThan(0);
    expect(res.lines.join("\n")).toContain("page pairs sharing 3+ top-10 results");
    expect(existsSync(join(dir, "map-review.seo.txt"))).toBe(true);
    expect(existsSync(join(dir, "map-review.owner.txt"))).toBe(true);
    // Its files are named for the runner, and the numbers are there for --json.
    expect(res.outputs).toEqual({
      eval: join(dir, "map-eval.json"),
      "review seo": join(dir, "map-review.seo.txt"),
      "review owner": join(dir, "map-review.owner.txt"),
    });
    expect(res.data).toMatchObject({
      metrics: { duplicateIntentPairs: 1 },
      missed: expect.arrayContaining(["duplicateIntentPairs"]),
    });

    // A missing map is an input error with a fix, raised before any run starts.
    const missing = await evalMapRun({
      runsDir: join(dir, "runs"),
      mapFile: join(dir, "nope.json"),
    }).catch((err: unknown) => describeError(err));
    expect(missing).toMatchObject({
      code: "INPUT_MISSING",
      message: `no topical map at ${join(dir, "nope.json")}`,
      fix: "run mycel map first, or pass the path of the file it wrote",
    });
  });
});
