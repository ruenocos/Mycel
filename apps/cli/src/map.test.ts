import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiteMaps } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import { mapRun } from "./map.ts";

const fixture = (name: string) => join(import.meta.dirname, "../../../fixtures/clients", name);
const tmp = () => mkdtempSync(join(tmpdir(), "mycel-cli-map-"));

const cluster = (id: string, label: "core" | "outer", main: string, volume: number) => ({
  id,
  mainQuery: main,
  hub: main,
  queries: [main],
  sharedUrls: [],
  qdp: "page",
  outlier: false,
  label,
  entity: "kamerplant",
  members: [
    {
      query: main,
      shared: 10,
      volume,
      scores: { relevance: 1, prominence: 0.5, popularity: 0.5 },
    },
  ],
  demand: { volume, gscImpressions: 0 },
  aiOverview: { present: false, cited: false },
  serpFeatures: [],
  qdpWhy: "Its own results page, so its own page.",
  outlierReasons: [],
});

function setup(confirmed = true) {
  const dir = tmp();
  const context = JSON.parse(readFileSync(join(fixture("plantpost"), "context.json"), "utf8"));
  writeFileSync(
    join(dir, "context.json"),
    JSON.stringify(confirmed ? context : { ...context, confirmed: undefined }),
  );
  writeFileSync(
    join(dir, "clusters.json"),
    JSON.stringify({
      site: context.site,
      market: context.market,
      minSharedUrls: 3,
      clusters: [
        cluster("kopen", "core", "kamerplanten kopen", 4000),
        cluster("grote", "core", "grote kamerplant kopen", 1200),
        cluster("verpotten", "outer", "kamerplant verpotten", 1500),
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
  return dir;
}

describe("mycel map", () => {
  it("maps a clusters file with the fake model, links pages and runs the gate", async () => {
    const dir = setup();
    const res = await mapRun({
      runsDir: join(dir, "runs"),
      clustersFile: join(dir, "clusters.json"),
      pagesFile: join(fixture("plantpost"), "pages.json"),
      expectFile: join(fixture("plantpost"), "expectations.json"),
      provider: "fake",
      model: "m",
      allowUnconfirmed: true,
      env: {},
    });
    const maps = SiteMaps.parse(JSON.parse(readFileSync(join(dir, "topical-map.json"), "utf8")));
    const nodes = maps.maps[0]?.nodes ?? [];
    expect(nodes[0]).toMatchObject({ id: "root-kamerplant", level: "root", proposedUrl: "/" });
    expect(nodes.find((n) => n.mainQuery === "grote kamerplant kopen")?.parentId).toBe("n-kopen");
    expect(nodes.find((n) => n.mainQuery === "kamerplant verpotten")?.existingPage?.url).toBe(
      "/verzorging/kamerplant-verpotten/",
    );
    const text = res.lines.join("\n");
    expect(text).toContain("map         kamerplant: 4 pages, 3 core, 1 outer");
    expect(text).toContain("note        no queries.json: intent falls back to the tier");
    // Three clusters can't pass the plantpost gate (most expected queries have no data, and
    // the XL page shares no query with any node): the run says so and fails.
    expect(res.gate?.checks.find((c) => c.expect === "kamerplanten kopen")?.status).toBe("pass");
    expect(res.gate?.passed).toBe(false);
    expect(res.ok).toBe(false);
  });

  it("refuses an unconfirmed context unless asked for a dry run", async () => {
    const dir = setup(false);
    await expect(
      mapRun({
        runsDir: join(dir, "runs"),
        clustersFile: join(dir, "clusters.json"),
        provider: "fake",
        model: "m",
        env: {},
      }),
    ).rejects.toThrow(/isn't confirmed yet/);
  });
});
