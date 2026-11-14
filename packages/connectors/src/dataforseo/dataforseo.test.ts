import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiCallInput, CallRecorder } from "../recorder.ts";
import { requestHash, stableStringify } from "./cache.ts";
import { BudgetExceededError, DataforseoClient, LiveCallBlockedError } from "./client.ts";
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
