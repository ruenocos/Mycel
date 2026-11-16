import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientContext, ClusterDetail, ClusterSet } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import { RunStore } from "../log/run-store.ts";
import { runStep } from "../step.ts";
import {
  clusterCoverage,
  contentUrls,
  gapTopics,
  pickCompetitors,
  type SitemapLike,
  siteSignals,
} from "./competitors.ts";
import { signalsStep, trendTopics } from "./step.ts";
import {
  buildTrends,
  clusterSeries,
  type HistoryLike,
  peaksOf,
  publishByOf,
  topicTrend,
  trendOf,
} from "./trends.ts";

const series = (start: [number, number], volumes: number[]) =>
  volumes.map((volume, i) => {
    const m = start[1] - 1 + i;
    return { year: start[0] + Math.floor(m / 12), month: (m % 12) + 1, volume };
  });

const asPoints = (h: HistoryLike) =>
  h.monthly.map((m) => ({
    month: `${m.year}-${String(m.month).padStart(2, "0")}`,
    volume: m.volume,
  }));

const cluster = (
  id: string,
  main: string,
  queries: string[] = [main],
  volume = 100,
): ClusterDetail => ({
  id,
  mainQuery: main,
  hub: main,
  queries,
  sharedUrls: [],
  qdp: "page",
  outlier: false,
  label: "core",
  members: queries.map((q) => ({
    query: q,
    shared: 10,
    volume,
    scores: { relevance: 1, prominence: 0.5, popularity: 0.5 },
  })),
  demand: { volume, gscImpressions: 0 },
  aiOverview: { present: false, cited: false },
  serpFeatures: [],
  qdpWhy: "Its own results page.",
  outlierReasons: [],
});

describe("trends (step 14)", () => {
  it("calls a topic rising or falling against the same months a year earlier", () => {
    const up = series(
      [2024, 11],
      [...Array(12).fill(50), 60, 60, 60, 60, 60, 60, 60, 60, 60, 80, 80, 80],
    );
    expect(trendOf(asPoints({ keyword: "x", monthly: up }))).toMatchObject({
      label: "rising",
      change: 0.6,
    });
    const down = series([2024, 11], [...Array(12).fill(100), ...Array(12).fill(50)]);
    expect(trendOf(asPoints({ keyword: "x", monthly: down }))).toMatchObject({
      label: "falling",
      change: -0.5,
    });
  });

  it("finds the peak months of a seasonal search and when to publish before them", () => {
    // Searched in spring: April and May peak, so the page goes up by February.
    const spring = [20, 20, 25, 90, 100, 25, 20, 20, 20, 20, 20, 20];
    expect(peaksOf(spring)).toEqual([4, 5]);
    expect(publishByOf([4, 5])).toBe(2);
    // A run over the new year starts in December: publish by October.
    expect(publishByOf([12, 1])).toBe(10);
    const t = trendOf(asPoints({ keyword: "x", monthly: series([2025, 1], spring) }));
    expect(t).toMatchObject({ label: "seasonal", peakMonths: [4, 5], publishBy: 2 });
    expect(peaksOf(Array(12).fill(40))).toEqual([]);
  });

  it("says nothing about a search with too little history or demand", () => {
    expect(
      trendOf(asPoints({ keyword: "x", monthly: series([2025, 1], [5, 5, 5, 5, 5, 5, 5, 5]) })),
    ).toBe(undefined);
    expect(trendOf(asPoints({ keyword: "x", monthly: series([2025, 1], [50, 50]) }))).toBe(
      undefined,
    );
  });

  it("counts a spelling variant with the very same series once", () => {
    const monthly = series([2025, 1], Array(12).fill(40));
    const h = new Map<string, HistoryLike>([
      ["monstera", { keyword: "monstera", monthly }],
      ["monsterra", { keyword: "monsterra", monthly }],
      [
        "monstera kopen",
        { keyword: "monstera kopen", monthly: series([2025, 1], Array(12).fill(10)) },
      ],
    ]);
    const s = clusterSeries(["monstera", "monsterra", "monstera kopen"], h);
    expect(s.monthly).toHaveLength(12);
    expect(s.monthly[0]?.volume).toBe(50);
  });

  it("reads a topic's long curve from Google Trends", () => {
    const points = Array.from({ length: 36 }, (_, i) => ({
      date: `${2023 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`,
      value: i < 24 ? 40 : 60,
    }));
    expect(topicTrend("kamerplant", points)).toMatchObject({ label: "rising", change: 0.5 });
    expect(topicTrend("kamerplant", points.slice(0, 10))).toBe(undefined);
  });

  it("marks a page whose search rises in Google Trends, and lists the rest as ideas", () => {
    const t = buildTrends({
      clusters: [cluster("c1", "monstera verpotten"), cluster("c2", "calathea")],
      histories: new Map(),
      explores: [
        {
          keywords: ["kamerplant"],
          graph: [],
          rising: [
            { query: "Monstera verpotten", value: 250 },
            { query: "kamerplant lamp", value: 5000 },
          ],
        },
      ],
      language: "nl",
    });
    expect(t.clusters).toEqual([
      expect.objectContaining({ clusterId: "c1", label: "rising", risingInTrends: true }),
    ]);
    expect(t.ideas).toEqual([{ query: "kamerplant lamp", growthPct: 5000, under: "kamerplant" }]);
  });
});

const NOW = new Date("2026-11-16T07:00:00.000Z");

const sitemap = (
  domain: string,
  paths: [string, string?][],
  status: SitemapLike["status"] = "ok",
): SitemapLike => ({
  domain,
  status,
  truncated: false,
  urls: paths.map(([p, lastmod]) => ({
    loc: `https://${domain}${p}`,
    ...(lastmod ? { lastmod } : {}),
  })),
});

describe("competitors (steps 8 and 11)", () => {
  const a = sitemap("planten-a.nl", [
    ["/blog/monstera-verpotten/", "2026-10-02"],
    ["/blog/calathea-verzorgen/", "2026-09-12"],
    ["/blog/kamerplant-lamp-kiezen/", "2026-08-01"],
    ["/blog/kamerplant-lamp-kopen/", "2026-08-02"],
    ["/tag/groen/"],
    ["/privacy/"],
    ["/afbeelding.jpg"],
  ]);
  const b = sitemap("planten-b.nl", [
    ["/gids/monstera-verpotten"],
    ["/gids/kamerplant-lamp"],
    ["/gids/pothos"],
  ]);

  it("counts content pages only, with folders and changes per month", () => {
    expect(contentUrls(a)).toHaveLength(4);
    const { site } = siteSignals(a, NOW);
    expect(site).toMatchObject({
      domain: "planten-a.nl",
      pages: 4,
      sections: [{ folder: "/blog/", pages: 4 }],
      dated: 1,
    });
    expect(site.changesPerMonth.find((m) => m.month === "2026-08")?.volume).toBe(2);
    expect(site.perMonth).toBeCloseTo(4 / 12, 1);
  });

  it("leaves momentum out when the sitemap stamps every page with one day", () => {
    const stamped = sitemap(
      "x.nl",
      Array.from({ length: 30 }, (_, i) => [`/p${i}/`, "2026-11-16"] as [string, string]),
    );
    const r = siteSignals(stamped, NOW);
    expect(r.site).toMatchObject({ perMonth: 0, dated: 0, changesPerMonth: [] });
    expect(r.warning).toMatch(/generated/);
  });

  it("finds which competitors have a page on each page topic", () => {
    const cov = clusterCoverage({
      clusters: [
        cluster("c1", "monstera verpotten"),
        cluster("c2", "pilea"),
        cluster("c3", "calathea utrecht"),
      ],
      sites: [a, b],
      language: "nl",
      city: "Utrecht",
    });
    expect(cov).toEqual([
      {
        clusterId: "c1",
        competitors: ["planten-a.nl", "planten-b.nl"],
        urls: [
          "https://planten-a.nl/blog/monstera-verpotten/",
          "https://planten-b.nl/gids/monstera-verpotten",
        ],
      },
      // The city is left out of the words to match.
      {
        clusterId: "c3",
        competitors: ["planten-a.nl"],
        urls: ["https://planten-a.nl/blog/calathea-verzorgen/"],
      },
    ]);
  });

  it("lists topics two competitors write about that no kept search covers", () => {
    const kept = (t: string) => ({
      text: t,
      normalized: t,
      sources: ["dfs_related" as const],
      metrics: {},
      filter: { kept: true },
      scores: { relevance: 1, prominence: 1, popularity: 1 },
    });
    const gaps = gapTopics({
      sites: [a, b],
      queries: [kept("monstera verpotten"), kept("calathea verzorgen")],
      language: "nl",
      ownDomain: "plantpost.example",
    });
    expect(gaps.map((g) => g.topic)).toEqual(["kamerplant lamp"]);
    expect(gaps[0]).toMatchObject({ competitors: ["planten-a.nl", "planten-b.nl"], pages: 3 });
  });

  it("reads the confirmed competitors first, then the ones seen most in the results", () => {
    const ctx = {
      site: { url: "https://plantpost.example", name: "Plantpost" },
      competitors: ["www.planten-a.nl"],
    } as ClientContext;
    const cand = (domain: string, serpAppearances: number, platform = false) => ({
      domain,
      sources: ["serp" as const],
      serpAppearances,
      platform,
      inContext: false,
      mined: false,
    });
    expect(
      pickCompetitors(ctx, [
        cand("wikipedia.org", 20, true),
        cand("planten-c.nl", 2),
        cand("planten-b.nl", 8),
        cand("plantpost.example", 9),
        cand("planten-d.nl", 4),
      ]),
    ).toEqual(["planten-a.nl", "planten-b.nl", "planten-d.nl"]);
  });
});

describe("signals step", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../../fixtures/clients/plantpost/context.json"),
      "utf8",
    ),
  );
  const context: ClientContext = {
    ...fixture,
    offerings: ["grote kamerplanten", "hangplanten"],
    competitors: ["planten-a.nl", "planten-b.nl", "dicht.nl"],
  };
  const clusters: ClusterSet = {
    site: context.site,
    market: context.market,
    minSharedUrls: 3,
    clusters: [cluster("c1", "monstera verpotten"), cluster("c2", "kerststerren")],
    unclustered: [],
    stats: {
      queries: 2,
      clustered: 2,
      clusters: 2,
      pages: 2,
      sections: 0,
      micro: 0,
      singletons: 2,
      outliers: 0,
      ambiguousMembers: 0,
      borderlineMembers: 0,
      merged: 0,
      bridges: 0,
      leftOut: 0,
    },
  } as unknown as ClusterSet;

  it("puts trends and competitors in one file, with what failed as a warning", async () => {
    const asked: string[][] = [];
    const run = RunStore.create({
      runsDir: mkdtempSync(join(tmpdir(), "mycel-signals-")),
      client: "plantpost.example",
      command: "signals",
      cliVersion: "test",
    });
    const result = await runStep(
      run,
      signalsStep({
        keywords: {
          cachedKeywordHistories: () =>
            new Map([
              [
                "monstera verpotten",
                { keyword: "monstera verpotten", monthly: series([2025, 11], Array(12).fill(30)) },
              ],
            ]),
          keywordHistory: async (kws) => {
            asked.push(kws);
            // Christmas stars peak in November and December.
            return [
              {
                keyword: "kerststerren",
                monthly: series(
                  [2024, 11],
                  [
                    ...[300, 400, 20, 20, 20, 20, 20, 20, 20, 20, 20, 25],
                    ...[300, 400, 20, 20, 20, 20, 20, 20, 20, 20, 20, 25],
                  ],
                ),
              },
            ];
          },
          trendsExplore: async (kws) => {
            if (kws[0] === "hangplanten") throw new Error("HTTP 500");
            return { keywords: kws, graph: [], rising: [] };
          },
        },
        sitemaps: {
          read: async (domain) =>
            domain === "dicht.nl"
              ? {
                  domain,
                  status: "blocked",
                  reason: "bot check (HTTP 403)",
                  urls: [],
                  truncated: false,
                }
              : sitemap(domain, [["/monstera-verpotten/"]]),
        },
      }),
      { context, clusters, now: NOW.toISOString() },
    );
    run.finish();
    expect(asked).toEqual([["monstera verpotten", "kerststerren"]]);
    expect(result.trends?.clusters.find((c) => c.clusterId === "c2")).toMatchObject({
      label: "seasonal",
      peakMonths: [11, 12],
      publishBy: 9,
    });
    expect(result.trends?.coverage).toEqual({ clusters: 2, withTrend: 2 });
    expect(result.competitors?.sites.map((s) => s.status)).toEqual(["ok", "ok", "blocked"]);
    expect(result.competitors?.coverage).toEqual([
      expect.objectContaining({ clusterId: "c1", competitors: ["planten-a.nl", "planten-b.nl"] }),
    ]);
    expect(result.warnings).toEqual([
      'Google Trends for "hangplanten" failed: HTTP 500',
      "dicht.nl: sitemap blocked (bot check (HTTP 403))",
    ]);
  });

  it("asks Google Trends about the central entity, then the offerings", () => {
    expect(trendTopics(context)).toEqual(["kamerplant", "grote kamerplanten", "hangplanten"]);
  });
});
