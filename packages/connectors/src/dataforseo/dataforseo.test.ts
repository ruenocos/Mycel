import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiCallInput, CallRecorder } from "../recorder.ts";
import { FileCache, requestHash, stableStringify } from "./cache.ts";
import {
  BudgetExceededError,
  DataforseoClient,
  DataforseoError,
  LiveCallBlockedError,
} from "./client.ts";
import { findCity } from "./locations.ts";
import { parseCompetitorDomains, parseSerp } from "./parse.ts";
import { hostOfKey, isGoogleRedirect, keyFromBreadcrumb, normalizeUrl, resultKey } from "./url.ts";

const market = { country: "NL", language: "nl" } as const;

function recorder() {
  const calls: ApiCallInput[] = [];
  const warnings: string[] = [];
  const rec: CallRecorder = {
    recordApiCall: (c) => {
      calls.push(c);
      return String(calls.length);
    },
    log: { debug: () => {}, warn: (m) => void warnings.push(m) },
  };
  return { rec, calls, warnings };
}

const ok = (result: unknown, cost = 0.01, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      status_code: 20000,
      status_message: "Ok.",
      cost,
      tasks: [
        { id: "t1", status_code: 20000, status_message: "Ok.", cost, result: [result], ...extra },
      ],
    }),
    { status: 200 },
  );

/** Synthetic SERP in DataforSEO's shape (made-up domains, not client data). */
const serpFixture = {
  items: [
    {
      type: "ai_overview",
      references: [
        {
          url: "https://plantenwijzer.example/verzorging",
          domain: "plantenwijzer.example",
          title: "Verzorging",
          source: "Plantenwijzer",
        },
      ],
      items: [
        {
          references: [
            {
              url: "https://groenblad.example/water",
              domain: "groenblad.example",
              title: "Water geven",
            },
          ],
        },
      ],
    },
    {
      type: "organic",
      rank_group: 1,
      url: "https://www.Groenblad.example/Kamerplanten/?utm_source=x",
      domain: "www.groenblad.example",
      title: "A",
    },
    {
      type: "organic",
      rank_group: 2,
      url: "https://google.com/goto?url=CAESoAEBxCJF1zUD&gsessionid=abc",
      domain: "google.com",
      website_name: "plantenwijzer.example",
      breadcrumb: "https://www.plantenwijzer.example › kamerplanten › verzorging-van-...",
      title: "B",
    },
    { type: "people_also_ask", items: [{ title: "Hoe vaak water geven?" }] },
    { type: "related_searches", items: ["kamerplant kopen", "kamerplant voeding"] },
  ],
};

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "mycel-dfs-"));
});

const pendingFiles = () =>
  existsSync(join(cacheDir, "pending")) ? readdirSync(join(cacheDir, "pending")) : [];

const client = (
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof DataforseoClient>[0]> = {},
) =>
  new DataforseoClient({
    login: "user@example.com",
    password: "pw",
    cacheDir,
    budgetUsd: 1,
    fetchImpl,
    sleep: async () => {},
    pollIntervalMs: 0,
    ...extra,
  });

describe("url normalisation", () => {
  it("normalises host, slash, case and tracking params", () => {
    expect(
      normalizeUrl("https://www.Groenblad.example/Kamerplanten/?utm_source=x&b=2&a=1#top"),
    ).toBe("groenblad.example/kamerplanten?a=1&b=2");
    expect(normalizeUrl("http://groenblad.example/")).toBe("groenblad.example");
  });

  it("spots Google redirect links", () => {
    expect(isGoogleRedirect("https://google.com/goto?url=CAES")).toBe(true);
    expect(isGoogleRedirect("https://www.google.nl/url?q=https://x.nl")).toBe(true);
    expect(isGoogleRedirect("https://groenblad.example/goto")).toBe(false);
  });

  it("rebuilds a partial key from the breadcrumb, marking truncation", () => {
    expect(keyFromBreadcrumb("https://www.axians.example › marktsegment › erp-...")).toBe(
      "axians.example/marktsegment/erp-…",
    );
    expect(keyFromBreadcrumb("https://www.axians.example")).toBe("axians.example");
  });

  it("prefers the real url, then breadcrumb, then domain", () => {
    expect(resultKey({ url: "https://a.example/x" })?.source).toBe("url");
    expect(
      resultKey({ url: "https://google.com/goto?url=1", breadcrumb: "https://b.example › y" }),
    ).toEqual({
      key: "b.example/y",
      source: "breadcrumb",
    });
    expect(
      resultKey({
        url: "https://google.com/goto?url=1",
        domain: "google.com",
        website_name: "c.example",
      }),
    ).toEqual({
      key: "c.example",
      source: "domain",
    });
  });

  it("never takes a display name for a domain", () => {
    expect(
      resultKey({
        url: "https://google.com/goto?url=1",
        domain: "www.Shop.example",
        website_name: "Shop",
      }),
    ).toEqual({ key: "shop.example", source: "domain" });
    expect(
      resultKey({
        url: "https://google.com/goto?url=1",
        domain: "google.com",
        website_name: "Shop | NL",
      }),
    ).toBeNull();
    expect(hostOfKey("shop.example/planten")).toBe("shop.example");
    expect(hostOfKey("shop")).toBeNull();
  });

  it("gives organic results the real domain, not the website name", () => {
    const s = parseSerp("x", {
      items: [
        {
          type: "organic",
          rank_group: 1,
          url: "https://www.tuin.example/planten",
          domain: "www.tuin.example",
          website_name: "Tuincentrum",
          title: "T",
        },
      ],
    });
    expect(s.organic[0]?.domain).toBe("tuin.example");
  });
});

describe("parseSerp", () => {
  it("extracts organic keys, AI Overview refs, PAA and related searches", () => {
    const s = parseSerp("kamerplant verzorgen", serpFixture);
    expect(s.organic.map((o) => [o.key, o.urlSource])).toEqual([
      ["groenblad.example/kamerplanten", "url"],
      ["plantenwijzer.example/kamerplanten/verzorging-van-…", "breadcrumb"],
    ]);
    expect(s.unresolvedUrls).toBe(1);
    expect(s.aiOverview.present).toBe(true);
    expect(s.aiOverview.references.map((r) => r.domain)).toEqual([
      "plantenwijzer.example",
      "groenblad.example",
    ]);
    expect(s.peopleAlsoAsk).toEqual(["Hoe vaak water geven?"]);
    expect(s.relatedSearches).toEqual(["kamerplant kopen", "kamerplant voeding"]);
  });
});

describe("cache keys", () => {
  it("hash ignores key order", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(requestHash("e", { a: 1, b: 2 })).toBe(requestHash("e", { b: 2, a: 1 }));
  });
});

describe("DataforseoClient", () => {
  it("caches by request hash: second call is free and logged as a hit", async () => {
    let calls = 0;
    const related = {
      items: [
        { keyword_data: { keyword: "kamerplant", keyword_info: { search_volume: 900, cpc: 0.4 } } },
      ],
    };
    const c = client(async () => {
      calls++;
      return ok(related, 0.0125);
    });
    const { rec, calls: log } = recorder();

    const first = await c.relatedKeywords("kamerplant", market, rec);
    const second = await c.relatedKeywords("kamerplant", market, rec);
    expect(first).toEqual([{ keyword: "kamerplant", volume: 900, cpc: 0.4 }]);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect(c.spentUsd).toBe(0.0125);
    expect(log.map((l) => [l.cache, l.costUsd])).toEqual([
      ["miss", 0.0125],
      ["hit", 0],
    ]);
    expect(log[0]?.requestHash).toBe(log[1]?.requestHash);
  });

  it("sends the market as location and language", async () => {
    let body = "";
    const c = client(async (_url, init) => {
      body = String(init?.body);
      return ok({ items: [] });
    });
    await c.keywordSuggestions("kamerplant", market, recorder().rec);
    expect(JSON.parse(body)).toEqual([
      { keyword: "kamerplant", location_code: 2528, language_code: "nl", limit: 100 },
    ]);
  });

  it("stops at the budget", async () => {
    const c = client(async () => ok({ items: [] }, 0.6), { budgetUsd: 0.5 });
    const { rec } = recorder();
    await c.relatedKeywords("a", market, rec);
    await expect(c.relatedKeywords("b", market, rec)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("refuses a budget that isn't a number", () => {
    const make = (extra: Parameters<typeof client>[1]) => () => client(async () => ok(null), extra);
    expect(make({ budgetUsd: Number.NaN })).toThrow(/budgetUsd must be a number/);
    expect(make({ budgetUsd: -1 })).toThrow(RangeError);
    expect(make({ monthlyBudgetUsd: Number("fifty") })).toThrow(/monthlyBudgetUsd/);
  });

  it("holds the budget when calls run in parallel", async () => {
    let calls = 0;
    const c = client(
      async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return ok({ items: [] }, 0.02);
      },
      { budgetUsd: 0.05 },
    );
    const { rec } = recorder();
    const results = await Promise.allSettled(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => c.relatedKeywords(k, market, rec)),
    );
    // Same as one after the other: calls start while under budget, so three, not eight.
    expect(calls).toBe(3);
    expect(c.spentUsd).toBe(0.06);
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(5);
    expect(refused.every((r) => r.reason instanceof BudgetExceededError)).toBe(true);
  });

  it("keeps a monthly total across runs and stops at the monthly budget", async () => {
    const { rec } = recorder();
    const nov = () => new Date("2026-11-14T09:00:00Z");
    const run = (now: () => Date) =>
      client(async () => ok({ items: [] }, 0.02), { monthlyBudgetUsd: 0.03, now });

    const first = run(nov);
    await first.relatedKeywords("a", market, rec);
    await first.relatedKeywords("b", market, rec);
    expect(first.spentThisMonthUsd).toBe(0.04);

    // A new run has a fresh run budget, but the month is used up. Cached calls still work.
    const second = run(nov);
    expect(second.spentUsd).toBe(0);
    expect(second.spentThisMonthUsd).toBe(0.04);
    await expect(second.relatedKeywords("c", market, rec)).rejects.toThrow(
      /monthly budget of \$0.03 reached \(\$0.04 spent in 2026-11\)/,
    );
    await expect(second.relatedKeywords("a", market, rec)).resolves.toEqual([]);

    const december = run(() => new Date("2026-12-01T00:00:01Z"));
    expect(december.spentThisMonthUsd).toBe(0);
    await expect(december.relatedKeywords("c", market, rec)).resolves.toEqual([]);
  });

  it("counts what the cache says was already spent this month, once", async () => {
    new FileCache(cacheDir).set("ab".repeat(16), {
      endpoint: "dataforseo_labs/google/related_keywords/live",
      payload: {},
      fetchedAt: "2026-11-03T10:00:00.000Z",
      costUsd: 0.5,
      result: null,
    });
    new FileCache(cacheDir).set("cd".repeat(16), {
      endpoint: "dataforseo_labs/google/related_keywords/live",
      payload: {},
      fetchedAt: "2026-10-30T10:00:00.000Z",
      costUsd: 9,
      result: null,
    });
    const now = () => new Date("2026-11-14T09:00:00Z");
    expect(client(async () => ok(null), { now }).spentThisMonthUsd).toBe(0.5);
    expect(client(async () => ok(null), { now }).spentThisMonthUsd).toBe(0.5);
  });

  it("blocks paid SERP calls unless allowed, but serves cached SERPs", async () => {
    const { rec } = recorder();
    const blocked = client(async () => ok(serpFixture));
    await expect(blocked.serpOrganic("kamerplant", market, rec)).rejects.toBeInstanceOf(
      LiveCallBlockedError,
    );

    const responses = [
      ok(null, 0.0006), // task_post
      new Response(
        JSON.stringify({
          status_code: 20000,
          status_message: "Ok.",
          tasks: [{ status_code: 40602, status_message: "Task In Queue." }],
        }),
      ),
      ok(serpFixture, 0), // task_get
    ];
    const urls: string[] = [];
    const allowed = client(
      async (url) => {
        urls.push(String(url));
        return responses.shift() as Response;
      },
      { allowLiveSerp: true },
    );
    const serp = await allowed.serpOrganic("kamerplant", market, rec);
    expect(serp.organic).toHaveLength(2);
    expect(urls[0]).toMatch(/serp\/google\/organic\/task_post$/);
    expect(urls[2]).toMatch(/task_get\/advanced\/t1$/);
    expect(allowed.spentUsd).toBe(0.0006);

    // now cached: works even with paid SERPs off
    await expect(blocked.serpOrganic("kamerplant", market, rec)).resolves.toMatchObject({
      keyword: "kamerplant",
    });
  });

  it("fetches many SERPs in one batch: cache hits are free, the rest go through tasks_ready", async () => {
    const { rec } = recorder();
    // Seed the cache with one SERP via the single-SERP path.
    const single = [ok(null, 0.0006), ok(serpFixture, 0)];
    await client(async () => single.shift() as Response, { allowLiveSerp: true }).serpOrganic(
      "kamerplant",
      market,
      rec,
    );

    const posted: unknown[] = [];
    const c = client(
      async (url, init) => {
        const u = String(url);
        if (u.endsWith("/task_post")) {
          const body = JSON.parse(String(init?.body)) as { keyword: string; tag: string }[];
          posted.push(...body.map((b) => b.keyword));
          return new Response(
            JSON.stringify({
              status_code: 20000,
              status_message: "Ok.",
              cost: 0.0012,
              tasks: body.map((b, i) =>
                b.keyword === "kapot"
                  ? { status_code: 40501, status_message: "Invalid Field.", data: { tag: b.tag } }
                  : {
                      id: `id${i}`,
                      status_code: 20100,
                      status_message: "Task Created.",
                      cost: 0.0006,
                      data: { tag: b.tag },
                    },
              ),
            }),
          );
        }
        if (u.endsWith("/tasks_ready")) {
          return new Response(
            JSON.stringify({
              status_code: 20000,
              status_message: "Ok.",
              tasks: [
                {
                  status_code: 20000,
                  status_message: "Ok.",
                  result: [{ id: "id0" }, { id: "other-run" }],
                },
              ],
            }),
          );
        }
        if (u.endsWith("/task_get/advanced/id0")) return ok(serpFixture, 0);
        if (u.endsWith("/task_get/advanced/id2")) return ok(serpFixture, 0);
        throw new Error(`unexpected ${u}`);
      },
      { allowLiveSerp: true },
    );
    const res = await c.serpOrganicBatch(
      ["kamerplant", "monstera", "kapot", "pothos"],
      market,
      rec,
    );
    expect(posted).toEqual(["monstera", "kapot", "pothos"]);
    expect([...res.serps.keys()].sort()).toEqual(["kamerplant", "monstera", "pothos"]);
    expect(res.failed).toEqual([{ keyword: "kapot", error: "40501 Invalid Field." }]);
    expect(res.blocked).toEqual([]);
    expect(c.spentUsd).toBe(0.0012);

    // Second time everything that worked is cached; with paid SERPs off the rest is blocked.
    const off = client(async () => {
      throw new Error("no network expected");
    });
    const again = await off.serpOrganicBatch(["monstera", "pothos", "nieuw"], market, rec);
    expect(again.serps.size).toBe(2);
    expect(again.blocked).toEqual(["nieuw"]);
  });

  it("stops posting batches at the budget", async () => {
    const c = client(
      async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { tag: string }[];
        return new Response(
          JSON.stringify({
            status_code: 20000,
            status_message: "Ok.",
            tasks: body.map((b, i) => ({
              id: `t${i}`,
              status_code: 20100,
              status_message: "Created",
              cost: 0.5,
              data: { tag: b.tag },
            })),
          }),
        );
      },
      { allowLiveSerp: true, budgetUsd: 0.4 },
    );
    await expect(
      c.serpOrganicBatch(["a", "b", "c"], market, recorder().rec, { chunk: 1 }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("collects what was posted before stopping at the budget", async () => {
    const c = client(
      async (url, init) => {
        const u = String(url);
        if (u.endsWith("/task_post")) {
          const body = JSON.parse(String(init?.body)) as { tag: string }[];
          return new Response(
            JSON.stringify({
              status_code: 20000,
              status_message: "Ok.",
              tasks: body.map((b) => ({
                id: "paid",
                status_code: 20100,
                status_message: "Created",
                cost: 0.5,
                data: { tag: b.tag },
              })),
            }),
          );
        }
        if (u.endsWith("/tasks_ready")) return ok({ id: "paid" }, 0);
        return ok(serpFixture, 0);
      },
      { allowLiveSerp: true, budgetUsd: 0.4 },
    );
    const { rec } = recorder();
    await expect(c.serpOrganicBatch(["a", "b"], market, rec, { chunk: 1 })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    // "a" was paid for, so it is in the cache; nothing is left waiting.
    const off = client(async () => {
      throw new Error("no network expected");
    });
    const again = await off.serpOrganicBatch(["a", "b"], market, rec);
    expect([...again.serps.keys()]).toEqual(["a"]);
    expect(again.blocked).toEqual(["b"]);
    expect(pendingFiles()).toEqual([]);
  });

  it("never pays twice for a SERP that timed out: the next run collects the same task", async () => {
    const { rec } = recorder();
    const inQueue = () =>
      new Response(
        JSON.stringify({
          status_code: 20000,
          status_message: "Ok.",
          tasks: [{ status_code: 40602, status_message: "Task In Queue." }],
        }),
      );
    let posts = 0;
    const slow = client(
      async (url) => {
        if (String(url).endsWith("/task_post")) {
          posts++;
          return ok(null, 0.0006, { id: "slow1" });
        }
        return inQueue();
      },
      { allowLiveSerp: true, pollTimeoutMs: -1 },
    );
    await expect(slow.serpOrganic("kamerplant", market, rec)).rejects.toThrow(/next run collects/);
    expect(pendingFiles()).toHaveLength(1);

    // Next run: no task_post, the saved task id is collected. Works with paid SERPs off too.
    const urls: string[] = [];
    const next = client(async (url) => {
      urls.push(String(url));
      return ok(serpFixture, 0);
    });
    const serp = await next.serpOrganic("kamerplant", market, rec);
    expect(serp.organic).toHaveLength(2);
    expect(urls).toEqual([expect.stringMatching(/task_get\/advanced\/slow1$/)]);
    expect(posts).toBe(1);
    expect(next.spentUsd).toBe(0);
    expect(pendingFiles()).toEqual([]);
  });

  it("keeps batch task ids across a timeout and a failing task doesn't sink the batch", async () => {
    const { rec } = recorder();
    const post = (body: { keyword: string; tag: string }[]) =>
      new Response(
        JSON.stringify({
          status_code: 20000,
          status_message: "Ok.",
          tasks: body.map((b) => ({
            id: `task-${b.keyword}`,
            status_code: 20100,
            status_message: "Task Created.",
            cost: 0.0006,
            data: { tag: b.tag },
          })),
        }),
      );
    const none = () => ok(null, 0, { result: [] });
    let posts = 0;
    const first = client(
      async (url, init) => {
        const u = String(url);
        if (u.endsWith("/task_post")) {
          posts++;
          return post(JSON.parse(String(init?.body)));
        }
        if (u.endsWith("/tasks_ready")) return none();
        if (u.endsWith("task-monstera")) return ok(serpFixture, 0);
        if (u.endsWith("task-weg")) {
          return new Response(
            JSON.stringify({
              status_code: 20000,
              status_message: "Ok.",
              tasks: [{ status_code: 40401, status_message: "Task Not Found." }],
            }),
          );
        }
        return new Response(
          JSON.stringify({
            status_code: 20000,
            status_message: "Ok.",
            tasks: [{ status_code: 40602, status_message: "Task In Queue." }],
          }),
        );
      },
      { allowLiveSerp: true, pollTimeoutMs: -1 },
    );
    const res = await first.serpOrganicBatch(["monstera", "weg", "pothos"], market, rec);
    expect([...res.serps.keys()]).toEqual(["monstera"]);
    expect(res.failed).toEqual([
      { keyword: "weg", error: "40401 Task Not Found." },
      { keyword: "pothos", error: expect.stringMatching(/timeout; the task id is saved/) },
    ]);
    // Only the task that can still finish stays on disk.
    expect(pendingFiles()).toHaveLength(1);

    const urls: string[] = [];
    const second = client(async (url) => {
      const u = String(url);
      urls.push(u);
      if (u.endsWith("/tasks_ready")) throw new TypeError("fetch failed");
      return ok(serpFixture, 0);
    });
    const again = await second.serpOrganicBatch(["monstera", "pothos"], market, rec);
    expect([...again.serps.keys()].sort()).toEqual(["monstera", "pothos"]);
    expect(again.failed).toEqual([]);
    expect(urls.some((u) => u.endsWith("/task_post"))).toBe(false);
    expect(urls.at(-1)).toMatch(/task_get\/advanced\/task-pothos$/);
    expect(posts).toBe(1);
    expect(second.spentUsd).toBe(0);
    expect(pendingFiles()).toEqual([]);
  });

  it("posts a saved task again when DataforSEO no longer has it", async () => {
    const { rec, warnings } = recorder();
    const status = (code: number, message: string) =>
      new Response(
        JSON.stringify({
          status_code: 20000,
          status_message: "Ok.",
          tasks: [{ status_code: code, status_message: message }],
        }),
      );
    // Run 1 posts "old" and times out, so the id is saved.
    const first = client(
      async (url) =>
        String(url).endsWith("/task_post")
          ? ok(null, 0.0006, { id: "old" })
          : status(40602, "Task In Queue."),
      { allowLiveSerp: true, pollTimeoutMs: -1 },
    );
    await expect(first.serpOrganic("kamerplant", market, rec)).rejects.toThrow(/timeout/);

    // Run 2: DataforSEO lost "old". With paid SERPs off that is a blocked SERP, not a crash...
    const urls: string[] = [];
    const answer = async (url: string | URL | Request) => {
      const u = String(url);
      urls.push(u);
      if (u.endsWith("/task_post")) return ok(null, 0.0006, { id: "new" });
      return u.endsWith("/old") ? status(40401, "Task Not Found.") : ok(serpFixture, 0);
    };
    await expect(client(answer).serpOrganic("kamerplant", market, rec)).rejects.toBeInstanceOf(
      LiveCallBlockedError,
    );
    expect(pendingFiles()).toEqual([]);
    expect(warnings.at(-1)).toMatch(/can't be collected any more/);

    // ...and with them on, a fresh task is posted and collected.
    urls.length = 0;
    const serp = await client(answer, { allowLiveSerp: true }).serpOrganic(
      "kamerplant",
      market,
      rec,
    );
    expect(serp.organic).toHaveLength(2);
    expect(urls.map((u) => u.split("/").at(-1))).toEqual(["task_post", "new"]);

    // A fresh task that fails for good surfaces as an error and leaves nothing behind.
    const broken = client(
      async (url) =>
        String(url).endsWith("/task_post")
          ? ok(null, 0.0006, { id: "bad" })
          : status(40401, "Task Not Found."),
      { allowLiveSerp: true },
    );
    await expect(broken.serpOrganic("monstera", market, rec)).rejects.toBeInstanceOf(
      DataforseoError,
    );
    expect(pendingFiles()).toEqual([]);
  });

  it("retries 5xx and logs every attempt", async () => {
    const responses = [new Response("busy", { status: 503 }), ok({ items: [] })];
    const c = client(async () => responses.shift() as Response);
    const { rec, calls, warnings } = recorder();
    await c.relatedKeywords("a", market, rec);
    expect(calls.map((l) => l.status)).toEqual(["error", 200]);
    expect(warnings).toHaveLength(1);
  });

  it("does not retry client errors like bad auth", async () => {
    let n = 0;
    const c = client(async () => {
      n++;
      return new Response(
        JSON.stringify({ status_code: 40100, status_message: "Unauthorized.", tasks: [] }),
      );
    });
    await expect(c.relatedKeywords("a", market, recorder().rec)).rejects.toThrow(/40100/);
    expect(n).toBe(1);
  });
});

/** A slice of DataforSEO's real NL location list (GET serp/google/locations/nl). */
const nlLocations = [
  { location_code: 20768, location_name: "Utrecht,Netherlands", location_type: "Province" },
  { location_code: 1010659, location_name: "Utrecht,Utrecht,Utrecht,Netherlands" },
  { location_code: 9063490, location_name: "Utrecht,Utrecht,Netherlands", type: "Municipality" },
  { location_code: 9050888, location_name: "Elst,Utrecht,Netherlands" },
  { location_code: 9050889, location_name: "Elst,Gelderland,Netherlands" },
  {
    location_code: 9063436,
    location_name: "Utrechtse Heuvelrug,Utrecht,Netherlands",
    type: "Municipality",
  },
  { location_code: 1010543, location_name: "'s-Hertogenbosch,North Brabant,Netherlands" },
].map(({ type, ...l }) => ({
  country_iso_code: "NL",
  location_type: type ?? "City",
  ...l,
}));

describe("city-level SERP locations", () => {
  const nl = (city: string) => ({ country: "NL", language: "nl", city });

  it("finds the city, not the province or municipality with the same name", () => {
    expect(findCity(nlLocations, nl("Utrecht")).match?.location_code).toBe(1010659);
    expect(findCity(nlLocations, nl("utrecht ")).match?.location_code).toBe(1010659);
    expect(findCity(nlLocations, nl("s Hertogenbosch")).match?.location_code).toBe(1010543);
    expect(findCity(nlLocations, nl("Utrechtse Heuvelrug")).match?.location_type).toBe(
      "Municipality",
    );
  });

  it("doesn't guess between namesakes; a region settles it", () => {
    const elst = findCity(nlLocations, nl("Elst"));
    expect(elst.match).toBeUndefined();
    expect(elst.candidates).toHaveLength(2);
    expect(findCity(nlLocations, nl("Elst, Gelderland")).match?.location_code).toBe(9050889);
    expect(findCity(nlLocations, nl("Atlantis"))).toEqual({ candidates: [] });
    expect(findCity(nlLocations, { country: "NL", language: "nl" })).toEqual({ candidates: [] });
  });

  const dfs = (seen: { url: string; body: unknown }[]) =>
    client(
      async (url, init) => {
        const u = String(url);
        seen.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (u.endsWith("/serp/google/locations/nl")) return ok(null, 0, { result: nlLocations });
        if (u.endsWith("/task_post")) {
          return ok(null, 0.0006, { status_code: 20100, status_message: "Task Created." });
        }
        if (u.includes("/task_get/")) return ok(serpFixture, 0);
        return ok({ items: [] }, 0.01);
      },
      { allowLiveSerp: true },
    );
  const locationCodes = (seen: { body: unknown }[]) =>
    seen.flatMap((s) =>
      Array.isArray(s.body) ? [(s.body[0] as { location_code: number }).location_code] : [],
    );

  it("asks Google from the market's city for SERPs and keeps keyword data at country level", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const c = dfs(seen);
    const { rec, warnings } = recorder();
    await c.serpOrganic("fysiotherapeut", nl("Utrecht"), rec);
    await c.serpOrganicBatch(["fysio lombok"], nl("Utrecht"), rec);
    await c.relatedKeywords("fysiotherapie", nl("Utrecht"), rec);
    expect(locationCodes(seen)).toEqual([1010659, 1010659, 2528]);
    // The location list is fetched once, and it is free.
    expect(seen.filter((s) => s.url.endsWith("/locations/nl"))).toHaveLength(1);
    expect(c.spentUsd).toBe(0.0112);
    expect(warnings).toEqual([]);

    // A later run reads the list from the cache.
    const again: { url: string; body: unknown }[] = [];
    await dfs(again).serpOrganic("fysiotherapeut", nl("Utrecht"), rec);
    expect(again).toEqual([]);
  });

  it("falls back to the country, with a warning, when the city can't be pinned down", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const c = dfs(seen);
    const { rec, warnings } = recorder();
    await c.serpOrganic("fysiotherapeut", nl("Elst"), rec);
    await c.serpOrganic("fysiotherapeut", nl("Atlantis"), rec);
    expect(locationCodes(seen)).toEqual([2528]); // the second call is the same request: cached
    expect(warnings).toEqual([
      expect.stringContaining("more than one place"),
      expect.stringContaining("not in DataforSEO's location list"),
    ]);
  });
});

describe("parseCompetitorDomains", () => {
  it("keeps domain, shared keywords and position, and drops the target itself", () => {
    const result = {
      items: [
        { domain: "www.desaak.com", intersections: 900, avg_position: 5 },
        { domain: "Exact.com", intersections: 120, avg_position: 18.5 },
        { domain: "afas.nl", intersections: 80 },
        { foo: "no domain" },
      ],
    };
    expect(parseCompetitorDomains(result, "desaak.com")).toEqual([
      { domain: "exact.com", intersections: 120, avgPosition: 18.5 },
      { domain: "afas.nl", intersections: 80 },
    ]);
  });
});
