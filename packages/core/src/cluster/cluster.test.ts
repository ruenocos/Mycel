import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientContext, type FilteredQuery, normalizeQuery } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import { RunStore } from "../log/run-store.ts";
import { runStep } from "../step.ts";
import {
  ClusterOptions,
  type ClusterSerp,
  clusterQueries,
  clusterStep,
  overlapKeys,
  type SerpBatchPort,
  stemToken,
  termSimilarity,
  termWeights,
  variantKey,
} from "./cluster.ts";

const ctx = ClientContext.parse({
  site: { url: "https://www.plant.example", name: "Plant" },
  market: { country: "NL", language: "nl" },
  sourceContext: "Webshop in kamerplanten.",
  centralEntities: [{ name: "kamerplant", disambiguation: "plant binnenshuis" }],
  centralSearchIntent: "kamerplant kopen",
});

const q = (
  text: string,
  over: { volume?: number; label?: "core" | "outer" | "bridge"; relevance?: number } = {},
): FilteredQuery => ({
  text,
  normalized: normalizeQuery(text),
  sources: ["dfs_related"],
  metrics: over.volume !== undefined ? { volume: over.volume } : {},
  label: over.label ?? "outer",
  entity: "kamerplant",
  filter: { kept: true },
  scores: { relevance: over.relevance ?? 0.6, prominence: 0.5, popularity: 0.5 },
});

/** A SERP whose top 10 are the given URL ids on example hosts. */
const serp = (keyword: string, urls: string[], extra: Partial<ClusterSerp> = {}): ClusterSerp => ({
  keyword,
  organic: urls.map((u, i) => ({
    rank: i + 1,
    key: `site${u}.example/page`,
    urlSource: "url" as const,
    domain: `site${u}.example`,
  })),
  aiOverview: { present: false, references: [] },
  itemTypes: ["organic"],
  ...extra,
});

const opts = ClusterOptions.parse({});
const run = (queries: FilteredQuery[], serps: ClusterSerp[]) =>
  clusterQueries({
    queries,
    serps: new Map(serps.map((s) => [s.keyword, s])),
    siteHost: "plant.example",
    options: opts,
  });

describe("overlapKeys", () => {
  it("uses top-10 real URLs and breadcrumbs, never bare domains", () => {
    const s = serp("x", ["1", "2"]);
    s.organic.push({ rank: 3, key: "bol.com", urlSource: "domain", domain: "bol.com" });
    s.organic.push({ rank: 11, key: "late.example/a", urlSource: "url", domain: "late.example" });
    expect([...overlapKeys(s)]).toEqual(["site1.example/page", "site2.example/page"]);
  });
});

describe("clusterQueries", () => {
  it("puts queries sharing 3+ URLs with the hub on one page, others on their own", () => {
    const r = run(
      [
        q("grote kamerplant kopen", { volume: 900, label: "core", relevance: 1 }),
        q("grote kamerplanten", { volume: 400, label: "core", relevance: 1 }),
        q("kamerplant xl", { volume: 90 }),
        q("monstera verzorgen", { volume: 300 }),
      ],
      [
        serp("grote kamerplant kopen", ["1", "2", "3", "4", "5", "6"]),
        serp("grote kamerplanten", ["1", "2", "3", "7", "8", "9"]),
        serp("kamerplant xl", ["1", "2", "8", "9", "10", "11"]), // 2 with the hub, 4 with a member
        serp("monstera verzorgen", ["20", "21", "22", "23", "24", "25"]),
      ],
    );
    const by = (main: string) => r.clusters.find((c) => c.members.some((m) => m.query === main));
    expect(by("grote kamerplanten")?.hub).toBe("grote kamerplant kopen");
    expect(by("grote kamerplanten")?.mainQuery).toBe("grote kamerplant kopen");
    // Same intent (doc 24): it shares 4 results with "grote kamerplanten", which is on the page.
    const xl = by("kamerplant xl")?.members.find((m) => m.query === "kamerplant xl");
    expect(by("kamerplant xl")?.hub).toBe("grote kamerplant kopen");
    expect(xl?.joined).toContain('shares 4 results with a query on "grote kamerplant kopen"');
    expect(by("monstera verzorgen")?.qdp).toBe("page");
    expect(by("grote kamerplanten")?.demand.volume).toBe(1390);
    expect(by("grote kamerplanten")?.label).toBe("core");
    expect(r.stats.borderlineMembers).toBe(1);
  });

  it("makes small clusters a section, and zero-demand ones micro context, on the closest page", () => {
    const r = run(
      [
        q("kamerplant verpotten", { volume: 500 }),
        q("kamerplant verpotten winter", { volume: 20 }),
        q("hoe vaak kamerplant verpotten?"),
      ],
      [
        serp("kamerplant verpotten", ["1", "2", "3", "4", "5", "6"]),
        serp("kamerplant verpotten winter", ["1", "2", "30", "31", "32", "33"]),
        serp("hoe vaak kamerplant verpotten?", ["1", "40", "41", "42", "43", "44"]),
      ],
    );
    const [page, section, micro] = r.clusters;
    expect(page?.qdp).toBe("page");
    expect(section).toMatchObject({ qdp: "section", hostClusterId: page?.id });
    expect(section?.qdpWhy).toContain("shares 2 results");
    expect(micro).toMatchObject({ qdp: "micro", hostClusterId: page?.id });
    expect(micro?.qdpWhy).toContain("FAQ");
  });

  it("flags thin SERPs, ambiguous members and orphans for review", () => {
    const r = run(
      [
        q("a", { volume: 900, relevance: 1 }),
        q("b", { volume: 800, relevance: 1 }),
        q("ab", { volume: 10 }),
        q("dun", { volume: 70 }),
        q("niks"),
      ],
      [
        serp("a", ["1", "2", "3", "4", "5", "6"]),
        serp("b", ["7", "8", "9", "10", "11", "12"]),
        serp("ab", ["1", "2", "3", "7", "8", "9"]),
        serp("dun", ["50", "51"]),
        serp("niks", ["60", "61", "62", "63", "64"]),
      ],
    );
    const by = (m: string) => r.clusters.find((c) => c.members.some((x) => x.query === m));
    expect(by("ab")?.outlierReasons.join(" ")).toContain('"ab" also matches "b"');
    expect(r.stats.ambiguousMembers).toBe(1);
    expect(by("dun")?.outlierReasons.join(" ")).toContain("thin SERP");
    expect(by("niks")).toMatchObject({ qdp: "micro", outlier: true });
    expect(by("niks")?.hostClusterId).toBeUndefined();
  });

  it("names the demand behind a section, including Search Console impressions", () => {
    const gsc = (text: string, impressions: number): FilteredQuery => ({
      ...q(text),
      metrics: { gscImpressions: impressions },
    });
    const r = run(
      [q("kamerplant verpotten", { volume: 500 }), gsc("kamerplant verpotten winter", 40)],
      [
        serp("kamerplant verpotten", ["1", "2", "3", "4", "5", "6"]),
        serp("kamerplant verpotten winter", ["1", "2", "30", "31", "32", "33"]),
      ],
    );
    expect(r.clusters[1]?.qdpWhy).toContain("(40 impressions in Search Console)");
    expect(r.clusters[1]?.qdpWhy).not.toContain("0/month");
  });

  it("notes AI Overviews and whether the client is cited, and blends SERP features into prominence", () => {
    const r = run(
      [q("kamerplant kopen", { volume: 1000, relevance: 1 })],
      [
        serp("kamerplant kopen", ["1", "2", "3", "4", "5"], {
          aiOverview: {
            present: true,
            references: [{ url: "https://www.plant.example/x", domain: "www.plant.example" }],
          },
          itemTypes: ["ai_overview", "people_also_ask", "popular_products", "images", "organic"],
        }),
      ],
    );
    const c = r.clusters[0];
    expect(c?.aiOverview).toEqual({ present: true, cited: true });
    expect(c?.serpFeatures).toEqual([
      "ai_overview",
      "people_also_ask",
      "popular_products",
      "images",
    ]);
    expect(c?.members[0]?.scores.prominence).toBe(0.75); // (0.5 evidence + 1.0 features) / 2
  });
});

describe("relevance tiers and merges", () => {
  it("folds spelling variants into one cluster", () => {
    const r = run(
      [q("groot kamerplant", { volume: 900 }), q("grote kamerplanten", { volume: 800 })],
      [
        serp("groot kamerplant", ["1", "2", "3", "4", "5", "6"]),
        serp("grote kamerplanten", ["1", "7", "8", "9", "10", "11"]),
      ],
    );
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]?.members.map((m) => m.joined)).toEqual([
      undefined,
      'spelling variant of "groot kamerplant"',
    ]);
    expect(r.stats.merged).toBe(1);
  });

  it("never gives a bridge topic its own page, however big", () => {
    const r = run(
      [
        q("kamerplant kopen", { volume: 500, label: "core", relevance: 1 }),
        q("planten", { volume: 15000, label: "bridge", relevance: 0.25 }),
      ],
      [
        serp("kamerplant kopen", ["1", "2", "3", "4", "5", "6"]),
        serp("planten", ["1", "20", "21", "22", "23", "24"]),
      ],
    );
    const bridge = r.clusters.find((c) => c.mainQuery === "planten");
    expect(bridge).toMatchObject({ label: "bridge", qdp: "section" });
    expect(bridge?.qdpWhy).toContain('Bridge topic on "kamerplant kopen"');
    expect(bridge?.qdpWhy).toContain("15000 searches a month");
  });

  it("stems Dutch variants but leaves other words alone", () => {
    expect(variantKey("grote kamerplanten", "nl")).toBe(variantKey("groot kamerplant", "nl"));
    expect(variantKey("manuele therapie", "nl")).toBe(variantKey("manueel therapie", "nl"));
    expect(variantKey("kamerplant kopen", "nl")).not.toBe(variantKey("kamerplant verpotten", "nl"));
    expect(variantKey("dracaena's", "nl")).toBe("dracaena");
    expect(stemToken("plants", "en")).toBe("plant");
  });
});

describe("term similarity", () => {
  it("weighs rare words more than common ones", () => {
    const w = termWeights([
      "kamerplant kopen",
      "kamerplant verpotten",
      "monstera kopen",
      "kamerplant water",
    ]);
    const rare = termSimilarity("monstera kopen", "monstera verzorgen", w);
    const common = termSimilarity("kamerplant kopen", "kamerplant verzorgen", w);
    expect(rare).toBeGreaterThan(common);
  });
});

describe("clusterStep", () => {
  it("fetches SERPs for kept queries only and lists the ones without a SERP", async () => {
    const asked: string[][] = [];
    const port: SerpBatchPort = {
      async serpOrganicBatch(keywords) {
        asked.push(keywords);
        return {
          serps: new Map([
            ["kamerplant kopen", serp("kamerplant kopen", ["1", "2", "3", "4", "5"])],
          ]),
          blocked: ["monstera"],
          failed: [{ keyword: "pothos", error: "40501 Invalid Field." }],
        };
      },
    };
    const drop: FilteredQuery = { ...q("tuinplant"), filter: { kept: false, reason: "not this" } };
    const out = await runStep(
      RunStore.create({
        runsDir: mkdtempSync(join(tmpdir(), "mycel-cluster-")),
        client: "t",
        command: "t",
        cliVersion: "0",
      }),
      clusterStep(port),
      {
        context: ctx,
        queries: {
          site: ctx.site,
          market: ctx.market,
          stats: { total: 4, kept: 3, dropped: { "not this": 1 } },
          queries: [q("kamerplant kopen", { volume: 100 }), q("monstera"), q("pothos"), drop],
        },
      },
    );
    expect(asked).toEqual([["kamerplant kopen", "monstera", "pothos"]]);
    expect(out.stats).toMatchObject({ queries: 3, clustered: 1, clusters: 1, pages: 1 });
    expect(out.unclustered.map((u) => u.query)).toEqual(["monstera", "pothos"]);
  });
});
