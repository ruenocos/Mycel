import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CallRecorder } from "../recorder.ts";
import { FileCache, requestHash } from "./cache.ts";
import { DataforseoClient } from "./client.ts";
import { PendingTasks } from "./pending.ts";
import { planSerpBatch, SERP_LIST_PRICE_USD, SERP_TASK_ENDPOINT, serpTaskPayload } from "./plan.ts";

const market = { country: "NL", language: "nl" } as const;
const rec: CallRecorder = {
  recordApiCall: () => "1",
  log: { debug: () => {}, warn: () => {} },
};

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "mycel-plan-"));
});

/** A DataforSEO that creates every task, delivers every result, and remembers what was bought. */
function server(pricePerSerp: number) {
  const bought: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = String(url);
    const json = (body: unknown) => new Response(JSON.stringify(body));
    if (u.endsWith("/task_post")) {
      const body = JSON.parse(String(init?.body)) as { keyword: string; tag: string }[];
      bought.push(...body.map((b) => b.keyword));
      return json({
        status_code: 20000,
        status_message: "Ok.",
        tasks: body.map((b) => ({
          id: `id-${b.keyword}`,
          status_code: 20100,
          status_message: "Task Created.",
          cost: pricePerSerp,
          data: { tag: b.tag },
        })),
      });
    }
    if (u.endsWith("/tasks_ready")) {
      return json({
        status_code: 20000,
        status_message: "Ok.",
        tasks: [
          {
            status_code: 20000,
            status_message: "Ok.",
            result: bought.map((k) => ({ id: `id-${k}` })),
          },
        ],
      });
    }
    if (u.includes("/task_get/advanced/")) {
      return json({
        status_code: 20000,
        status_message: "Ok.",
        tasks: [{ id: "x", status_code: 20000, status_message: "Ok.", result: [{ items: [] }] }],
      });
    }
    throw new Error(`unexpected ${u}`);
  };
  return { bought, fetchImpl };
}

const client = (fetchImpl: typeof fetch) =>
  new DataforseoClient({
    login: "user@example.com",
    password: "pw",
    cacheDir,
    budgetUsd: 1,
    allowLiveSerp: true,
    fetchImpl,
    sleep: async () => {},
    pollIntervalMs: 0,
  });

describe("planSerpBatch", () => {
  it("counts everything as to buy on an empty cache, at the list price", () => {
    const plan = planSerpBatch(cacheDir, ["a", "b", "a"], market);
    expect(plan).toMatchObject({
      total: 2,
      cached: 0,
      waiting: 0,
      toBuy: 2,
      priceUsd: SERP_LIST_PRICE_USD,
      priceSource: "list price",
      exact: true,
      spentThisMonthUsd: 0,
    });
    expect(plan.estimateUsd).toBeCloseTo(2 * SERP_LIST_PRICE_USD, 6);
  });

  it("predicts exactly what the real batch then buys, and prices it from the last purchase", async () => {
    const first = server(0.0007);
    await client(first.fetchImpl).serpOrganicBatch(["monstera", "pothos"], market, rec);

    const keywords = ["monstera", "pothos", "ficus", "calathea", "sansevieria"];
    const plan = planSerpBatch(cacheDir, keywords, market);
    expect(plan).toMatchObject({
      total: 5,
      cached: 2,
      waiting: 0,
      toBuy: 3,
      priceUsd: 0.0007,
      priceSource: "paid before",
    });
    expect(plan.estimateUsd).toBeCloseTo(0.0021, 6);
    expect(plan.spentThisMonthUsd).toBeCloseTo(0.0014, 6);

    const second = server(0.0007);
    const c = client(second.fetchImpl);
    await c.serpOrganicBatch(keywords, market, rec);
    expect(second.bought).toHaveLength(plan.toBuy);
    expect(c.spentUsd).toBeCloseTo(plan.estimateUsd, 6);

    // Fully cached now: nothing left to buy.
    expect(planSerpBatch(cacheDir, keywords, market)).toMatchObject({ cached: 5, toBuy: 0 });
  });

  it("counts a SERP an earlier run paid for but never collected as free, until it is too old", () => {
    const hash = requestHash(
      SERP_TASK_ENDPOINT,
      serpTaskPayload("ficus", { location_code: 2528, language_code: "nl" }),
    );
    const postedAt = "2026-11-10T09:00:00.000Z";
    new PendingTasks(join(cacheDir, "pending")).set(hash, {
      taskId: "t-1",
      endpoint: SERP_TASK_ENDPOINT,
      payload: {},
      postedAt,
      costUsd: 0.0006,
    });
    const at = (iso: string) => ({ now: () => new Date(iso) });
    expect(planSerpBatch(cacheDir, ["ficus"], market, at("2026-11-12T09:00:00Z"))).toMatchObject({
      waiting: 1,
      toBuy: 0,
    });
    expect(planSerpBatch(cacheDir, ["ficus"], market, at("2026-11-30T09:00:00Z"))).toMatchObject({
      waiting: 0,
      toBuy: 1,
    });
  });

  it("says so when a city market can't be matched yet, instead of guessing", () => {
    const utrecht = { ...market, city: "Utrecht" };
    const before = planSerpBatch(cacheDir, ["fysio"], utrecht);
    expect(before).toMatchObject({ exact: false, toBuy: 1 });

    // With the (free) location list in the cache, the city's own SERPs can be matched.
    const cache = new FileCache(cacheDir);
    cache.set(requestHash("serp/google/locations/nl", {}), {
      endpoint: "serp/google/locations/nl",
      payload: {},
      fetchedAt: "2026-11-14T09:00:00Z",
      costUsd: 0,
      result: [
        {
          location_code: 1005653,
          location_name: "Utrecht,Utrecht,Netherlands",
          country_iso_code: "NL",
          location_type: "City",
        },
      ],
    });
    const cityHash = requestHash(
      SERP_TASK_ENDPOINT,
      serpTaskPayload("fysio", { location_code: 1005653, language_code: "nl" }),
    );
    cache.set(cityHash, {
      endpoint: SERP_TASK_ENDPOINT,
      payload: {},
      fetchedAt: "2026-11-14T09:00:00Z",
      costUsd: 0.0006,
      result: { items: [] },
    });
    expect(planSerpBatch(cacheDir, ["fysio"], utrecht)).toMatchObject({
      exact: true,
      cached: 1,
      toBuy: 0,
    });
  });
});
