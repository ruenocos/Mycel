import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nullRecorder } from "../recorder.ts";
import { FileCache, requestHash } from "./cache.ts";
import { DataforseoClient } from "./client.ts";
import {
  ADS_VOLUME_ENDPOINT,
  adsAccepts,
  adsHistoryPayloads,
  cachedHistories,
  historyPlan,
  parseAdsVolume,
  parseLabsHistory,
  parseTrendsExplore,
  TRENDS_EXPLORE_ENDPOINT,
  trendsPayload,
} from "./history.ts";

const market = { country: "NL", language: "nl" } as const;
const months = (vs: number[]) => vs.map((v, i) => ({ year: 2026, month: i + 1, search_volume: v }));

const tasks = (result: unknown[], cost = 0.05) =>
  new Response(
    JSON.stringify({
      status_code: 20000,
      status_message: "Ok.",
      cost,
      tasks: [{ id: "t", status_code: 20000, status_message: "Ok.", cost, result }],
    }),
  );

describe("keyword history (step 14)", () => {
  it("reads the months and the yearly change from Labs results", () => {
    const related = {
      items: [
        {
          keyword_data: {
            keyword: "monstera",
            keyword_info: {
              monthly_searches: [...months([10, 20]).reverse()],
              search_volume_trend: { yearly: 25 },
            },
          },
        },
        { keyword_data: { keyword: "leeg", keyword_info: {} } },
      ],
    };
    expect(parseLabsHistory("dataforseo_labs/google/related_keywords/live", related)).toEqual([
      {
        keyword: "monstera",
        monthly: [
          { year: 2026, month: 1, volume: 10 },
          { year: 2026, month: 2, volume: 20 },
        ],
        yearlyChangePct: 25,
      },
    ]);
    const suggestions = {
      items: [{ keyword: "pilea", keyword_info: { monthly_searches: months([5]) } }],
    };
    expect(
      parseLabsHistory("dataforseo_labs/google/keyword_suggestions/live", suggestions),
    ).toHaveLength(1);
  });

  it("finds every history the cache already holds, the longest per keyword", () => {
    const cache = new FileCache(mkdtempSync(join(tmpdir(), "mycel-hist-")));
    const put = (endpoint: string, result: unknown) =>
      cache.set(requestHash(endpoint, { r: Math.random() }), {
        endpoint,
        payload: {},
        fetchedAt: "2026-11-01T00:00:00Z",
        costUsd: 0.01,
        result,
      });
    put("dataforseo_labs/google/related_keywords/live", {
      items: [
        {
          keyword_data: { keyword: "Monstera", keyword_info: { monthly_searches: months([1, 2]) } },
        },
      ],
    });
    put(ADS_VOLUME_ENDPOINT, [{ keyword: "monstera", monthly_searches: months([1, 2, 3, 4]) }]);
    put("serp/google/organic/task_get/advanced", { items: [] });
    const h = cachedHistories(cache);
    expect([...h.keys()]).toEqual(["monstera"]);
    expect(h.get("monstera")?.monthly).toHaveLength(4);
  });

  it("leaves out what Google Ads refuses and splits by 1000", () => {
    expect(adsAccepts("kamerplant kopen")).toBe(true);
    expect(adsAccepts("wat is de beste plant voor een donkere kamer zonder ramen of licht")).toBe(
      false,
    );
    expect(adsAccepts("plant (groot)")).toBe(false);
    const many = Array.from({ length: 1500 }, (_, i) => `plant ${i}`);
    const ps = adsHistoryPayloads([...many, "Plant 1"], market, "2024-11-01");
    expect(ps.map((p) => p.keywords.length)).toEqual([1000, 500]);
    expect(ps[0]).toMatchObject({
      location_code: 2528,
      language_code: "nl",
      date_from: "2024-11-01",
    });
  });

  it("reads Google Trends' curve and rising searches", () => {
    const t = parseTrendsExplore(["kamerplant"], {
      items: [
        {
          type: "google_trends_graph",
          data: [
            { date_from: "2026-01-04", values: [40] },
            { date_from: "2026-01-11", values: [null], missing_data: true },
          ],
        },
        {
          type: "google_trends_queries_list",
          data: {
            top: [{ query: "kamerplant kopen", value: 100 }],
            rising: [{ query: "plantenlamp", value: 350 }],
          },
        },
      ],
    });
    expect(t).toEqual({
      keywords: ["kamerplant"],
      graph: [{ date: "2026-01-04", values: [40] }],
      top: [{ query: "kamerplant kopen", value: 100 }],
      rising: [{ query: "plantenlamp", value: 350 }],
    });
    expect(
      parseAdsVolume([{ keyword: "x", monthly_searches: months([3]) }, { keyword: "y" }]),
    ).toHaveLength(1);
  });

  it("buys a history once, keeps every keyword of the answer, and counts what a run would buy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mycel-hist-client-"));
    const bodies: unknown[] = [];
    const client = new DataforseoClient({
      login: "l",
      password: "p",
      cacheDir: dir,
      budgetUsd: 1,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body))[0];
        bodies.push(body);
        if (body.item_types) return tasks([{ items: [] }], 0.01);
        return tasks([
          { keyword: "monstera", monthly_searches: months([1, 2]) },
          { keyword: "pilea", monthly_searches: months([3]) },
        ]);
      },
    });
    const plan = () =>
      historyPlan(new FileCache(dir), {
        keywords: ["monstera", "pilea"],
        topics: ["kamerplant"],
        market,
        dateFrom: "2024-11-01",
      });
    expect(plan()).toEqual({
      ads: { calls: 1, toBuy: 1 },
      trends: { calls: 1, toBuy: 1 },
      estimateUsd: 0.087,
    });
    const got = await client.keywordHistory(["monstera", "pilea"], market, nullRecorder, {
      dateFrom: "2024-11-01",
    });
    expect(got.map((h) => h.keyword)).toEqual(["monstera", "pilea"]);
    await client.keywordHistory(["pilea", "monstera"], market, nullRecorder, {
      dateFrom: "2024-11-01",
    });
    await client.trendsExplore(["kamerplant"], market, nullRecorder);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(trendsPayload(["kamerplant"], market));
    expect(plan()).toMatchObject({ ads: { toBuy: 0 }, trends: { toBuy: 0 }, estimateUsd: 0 });
    expect(client.cachedKeywordHistories().get("pilea")?.monthly).toHaveLength(1);
    expect(client.spentUsd).toBe(0.06);
    expect(TRENDS_EXPLORE_ENDPOINT).toMatch(/google_trends\/explore/);
  });
});
