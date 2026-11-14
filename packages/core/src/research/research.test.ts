import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientContext, type Market, ResearchDataset } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import type { JsonModel } from "../context/llm.ts";
import { RunStore } from "../log/run-store.ts";
import { runStep } from "../step.ts";
import {
  cleanDomain,
  isPlatform,
  QueryBag,
  type ResearchPort,
  rankCompetitors,
  researchStep,
  type SerpLike,
  serpDomainCounts,
} from "./collect.ts";
import {
  brandTokens,
  checkSeeds,
  deterministicSeeds,
  isBrandQuery,
  researchSeedsStep,
  type SeedProposal,
} from "./seeds.ts";

const fixtureContext = (name: string) =>
  ClientContext.parse(
    JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../../../fixtures/clients", name, "context.json"),
        "utf8",
      ),
    ),
  );

const consultancy = ClientContext.parse({
  site: { url: "https://www.acme-erp.nl", name: "Acme ERP" },
  market: { country: "NL", language: "nl" },
  sourceContext: "Verdient aan implementatie van ERP-software.",
  centralEntities: [{ name: "ERP-software", disambiguation: "bedrijfssoftware" }],
  centralSearchIntent: "ERP kiezen",
  offerings: ["ERP implementatie", "Consultancy en implementatie van ERP voor projectbedrijven"],
  competitors: ["www.rival.nl"],
});

const newRun = () =>
  RunStore.create({
    runsDir: mkdtempSync(join(tmpdir(), "mycel-research-")),
    client: "test",
    command: "test",
    cliVersion: "0.0.0",
  });

describe("brand detection", () => {
  it("takes tokens from the host and the site name", () => {
    expect(brandTokens(consultancy)).toEqual(["acmeerp"]);
    expect(isBrandQuery("acme erp ervaringen", brandTokens(consultancy))).toBe(true);
    expect(isBrandQuery("erp implementatie", brandTokens(consultancy))).toBe(false);
  });
});

describe("deterministicSeeds", () => {
  it("uses entities, short offerings and entity + city", () => {
    const ctx = fixtureContext("praktijk-beweegruimte");
    const seeds = deterministicSeeds(ctx);
    const texts = seeds.map((s) => s.normalized);
    expect(texts).toContain("fysiotherapie");
    expect(texts).toContain("fysiotherapie utrecht");
    expect(texts).toContain("dry needling");
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("skips sentence-length offerings, brand queries and far-off rankings", () => {
    const seeds = deterministicSeeds(consultancy, {
      gscQueries: [
        { query: "acme erp", impressions: 900 },
        { query: "erp voor bouwbedrijven", impressions: 40 },
      ],
      rankedKeywords: [
        { keyword: "erp systeem", volume: 1000, position: 45 },
        { keyword: "erp kosten", volume: 200, position: 8 },
      ],
    });
    const texts = seeds.map((s) => s.normalized);
    expect(texts).toEqual([
      "erp-software",
      "erp implementatie",
      "erp voor bouwbedrijven",
      "erp kosten",
    ]);
    expect(seeds.find((s) => s.normalized === "erp kosten")?.basis).toBe("ranked");
  });
});

describe("checkSeeds", () => {
  it("drops long, duplicate, brand, competitor and unanchored seeds", () => {
    const base = deterministicSeeds(consultancy);
    const proposal: SeedProposal = {
      seeds: [
        { query: "ERP pakket vergelijken", ref: "ERP-software" },
        { query: "erp implementatie", ref: "ERP implementatie" },
        { query: "beste erp software voor kleine bedrijven in nederland", ref: "ERP-software" },
        { query: "acme erp prijzen", ref: "ERP-software" },
        { query: "rival erp review", ref: "ERP-software" },
        { query: "boekhoudpakket", ref: "boekhouding" },
      ],
    };
    const { seeds, dropped } = checkSeeds(consultancy, base, proposal);
    expect(seeds.map((s) => s.text)).toEqual(["erp pakket vergelijken"]);
    expect(dropped.map((d) => d.reason)).toEqual([
      "duplicate",
      "too long",
      "own brand",
      "competitor brand",
      "ref is not an entity or offering",
    ]);
  });

  it("runs as a step and logs the model call through the stub", async () => {
    const requests: unknown[] = [];
    const llm: JsonModel = {
      async generateJson(req, schema) {
        requests.push(req);
        return schema.parse({ seeds: [{ query: "erp kiezen", ref: "ERP-software" }] });
      },
    };
    const seeds = await runStep(newRun(), researchSeedsStep(llm), {
      context: consultancy,
      model: "m",
    });
    expect(seeds.map((s) => s.basis)).toEqual(["entity", "offering", "model"]);
    expect(JSON.stringify(requests[0])).toContain("research-seeds");
  });
});

describe("QueryBag", () => {
  it("dedupes, merges sources and keeps the first metrics", () => {
    const bag = new QueryBag();
    bag.add("ERP  Kosten", "dfs_related", {
      idea: { keyword: "erp kosten", volume: 210.4, competition: 1.3, intent: "commercial" },
    });
    bag.add("erp kosten", "dfs_suggestions", { idea: { keyword: "erp kosten", volume: 999 } });
    bag.add("erp kosten", "gsc", { gsc: { clicks: 2, impressions: 80, position: 12.5 } });
    bag.add("erp kosten", "gsc");
    bag.add("erp", "dfs_related", { idea: { keyword: "erp", intent: "weird" } });
    const [q, other] = bag.list();
    expect(bag.size).toBe(2);
    expect(q?.sources).toEqual(["dfs_related", "dfs_suggestions", "gsc"]);
    expect(q?.metrics).toEqual({
      volume: 210,
      competition: 1,
      gscClicks: 2,
      gscImpressions: 80,
      gscPosition: 12.5,
    });
    expect(q?.intent).toBe("commercial");
    expect(other?.intent).toBeUndefined();
  });
});

const serp = (keyword: string, domains: string[], extra: Partial<SerpLike> = {}): SerpLike => ({
  keyword,
  organic: domains.map((d, i) => ({
    rank: i + 1,
    title: d,
    key: `${d}/`,
    url: `https://${d}/`,
    domain: d,
  })),
  aiOverview: { present: false, references: [] },
  peopleAlsoAsk: [],
  relatedSearches: [],
  ...extra,
});

describe("competitor discovery", () => {
  it("counts domains once per SERP, without the client itself", () => {
    const counts = serpDomainCounts(
      [
        serp("a", [
          "www.niche.nl",
          "niche.nl",
          "acme-erp.nl",
          "blog.acme-erp.nl",
          "nl.wikipedia.org",
        ]),
        serp("b", ["niche.nl", "other.nl"]),
      ],
      "acme-erp.nl",
    );
    expect(Object.fromEntries(counts)).toEqual({
      "niche.nl": 2,
      "nl.wikipedia.org": 1,
      "other.nl": 1,
    });
  });

  it("mines confirmed competitors first, then repeat SERP players, never platforms", () => {
    const ranked = rankCompetitors(
      {
        context: ["www.rival.nl"],
        labs: [{ domain: "big.com", intersections: 40 }],
        serpCounts: new Map([
          ["niche.nl", 4],
          ["youtube.com", 5],
          ["once.nl", 1],
          ["small.nl", 2],
        ]),
      },
      { minSerps: 2, maxMined: 3 },
    );
    expect(ranked.filter((c) => c.mined).map((c) => c.domain)).toEqual([
      "rival.nl",
      "niche.nl",
      "small.nl",
    ]);
    expect(ranked.find((c) => c.domain === "youtube.com")?.platform).toBe(true);
    expect(ranked.find((c) => c.domain === "once.nl")).toBeUndefined();
    expect(ranked.find((c) => c.domain === "big.com")).toMatchObject({
      sources: ["labs"],
      sharedKeywords: 40,
      mined: false,
    });
  });

  it("knows platforms and cleans domains", () => {
    expect(isPlatform("nl.linkedin.com")).toBe(true);
    expect(isPlatform("linkedin-experts.nl")).toBe(false);
    expect(cleanDomain("https://WWW.Example.nl/path")).toBe("example.nl");
  });
});

/** A stub data provider: every seed gets two ideas, SERPs come from a table. */
function stubPort(serps: Record<string, SerpLike | "blocked">): ResearchPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async relatedKeywords(seed) {
      calls.push(`related:${seed}`);
      return [{ keyword: `${seed} kosten`, volume: 50, detectedLanguage: "nl" }];
    },
    async keywordSuggestions(seed) {
      calls.push(`suggest:${seed}`);
      return [{ keyword: `${seed} kosten`, volume: 70 }, { keyword: `beste ${seed}` }];
    },
    async rankedKeywords(target) {
      calls.push(`ranked:${target}`);
      return [{ keyword: `${target.split(".")[0]} keyword`, volume: 10, position: 3 }];
    },
    async competitorDomains(target) {
      calls.push(`competitors:${target}`);
      return [{ domain: "big.com", intersections: 12 }];
    },
    async serpOrganic(keyword) {
      calls.push(`serp:${keyword}`);
      const s = serps[keyword];
      if (s === "blocked" || !s) {
        const err = new Error("not cached");
        err.name = "LiveCallBlockedError";
        throw err;
      }
      return s;
    },
  };
}

describe("researchStep", () => {
  const market: Market = { country: "NL", language: "nl" };
  const seeds = [
    { text: "erp", normalized: "erp", basis: "entity" as const },
    { text: "erp implementatie", normalized: "erp implementatie", basis: "offering" as const },
    { text: "erp kiezen", normalized: "erp kiezen", basis: "model" as const },
  ];

  it("collects every source, finds SERP competitors and validates the dataset", async () => {
    const port = stubPort({
      erp: serp("erp", ["niche.nl", "youtube.com", "acme-erp.nl"], {
        aiOverview: {
          present: true,
          references: [{ url: "https://niche.nl/a", domain: "niche.nl" }],
        },
        peopleAlsoAsk: ["Wat kost een ERP?"],
        relatedSearches: ["erp systeem"],
      }),
      "erp implementatie": serp("erp implementatie", ["niche.nl", "youtube.com"]),
      "erp kiezen": "blocked",
    });
    const d = await runStep(newRun(), researchStep(port), {
      context: consultancy,
      seeds,
      pages: [{ url: "/", kind: "home", title: "Acme", h1: "Acme" }],
      gscRows: [{ query: "ERP kosten", clicks: 3, impressions: 90, position: 9 }],
    });
    expect(d.market).toEqual(market);
    const q = d.queries.find((x) => x.normalized === "erp kosten");
    expect(q?.sources).toEqual(["dfs_related", "dfs_suggestions", "gsc"]);
    expect(q?.metrics.volume).toBe(50);
    expect(q?.language).toBe("nl");
    expect(d.queries.find((x) => x.normalized === "wat kost een erp?")?.sources).toEqual([
      "serp_paa",
    ]);
    expect(d.queries.find((x) => x.normalized === "erp systeem")?.sources).toEqual([
      "serp_related",
    ]);
    expect(d.serps).toHaveLength(2);
    expect(d.serps[0]?.aiOverview.present).toBe(true);
    expect(d.competitors.filter((c) => c.mined).map((c) => c.domain)).toEqual([
      "rival.nl",
      "niche.nl",
    ]);
    expect(d.competitors.find((c) => c.domain === "niche.nl")).toMatchObject({
      sources: ["serp"],
      inContext: false,
      serpAppearances: 2,
    });
    expect(port.calls).toContain("ranked:niche.nl");
    expect(port.calls).not.toContain("ranked:youtube.com");
    expect(d.warnings.join(" ")).toContain("1 of 3 seed SERPs were skipped");
    expect(d.coverage.find((c) => c.source === "serp")?.note).toContain("1 skipped");
  });

  it("keeps how far each SERP URL can be trusted (ADR 0010)", async () => {
    const trusted = serp("erp", ["niche.nl", "rival.nl"], { unresolvedUrls: 1 });
    const [first, second] = trusted.organic;
    if (first) first.urlSource = "url";
    if (second) Object.assign(second, { urlSource: "domain", url: null, key: "rival.nl" });
    const d = await runStep(newRun(), researchStep(stubPort({ erp: trusted })), {
      context: consultancy,
      seeds: seeds.slice(0, 1),
    });
    expect(d.serps[0]?.organic.map((o) => o.urlSource)).toEqual(["url", "domain"]);
    expect(d.serps[0]?.unresolvedUrls).toBe(1);
    expect(d.coverage.find((c) => c.source === "serp")?.note).toBe(
      "1 of 2 results known by domain only",
    );
    // A dataset saved before the field existed still reads.
    const old = structuredClone(d);
    for (const s of old.serps) {
      delete s.unresolvedUrls;
      for (const o of s.organic) delete o.urlSource;
    }
    expect(ResearchDataset.parse(old).serps[0]?.organic[0]?.urlSource).toBeUndefined();
  });

  it("asks nothing about test domains and warns when GSC is missing", async () => {
    const ctx = fixtureContext("plantpost");
    const port = stubPort({});
    const d = await runStep(newRun(), researchStep(port), {
      context: ctx,
      seeds: [{ text: "kamerplant", normalized: "kamerplant", basis: "entity" }],
      options: { serps: false },
    });
    expect(port.calls).toEqual(["related:kamerplant", "suggest:kamerplant"]);
    expect(d.coverage.find((c) => c.source === "dfs_ranked_site")?.note).toContain("test domain");
    expect(d.warnings.join(" ")).toContain("No Search Console data");
  });

  it("skips display names and a competitor whose lookup fails, but still stops on the budget", async () => {
    const port = stubPort({
      erp: serp("erp", ["niche.nl", "intratuin", "broken.nl"]),
      "erp implementatie": serp("erp implementatie", ["niche.nl", "intratuin", "broken.nl"]),
      "erp kiezen": "blocked",
    });
    const ranked = port.rankedKeywords;
    port.rankedKeywords = async (target, m, rec) => {
      if (target === "broken.nl") throw new Error("40501 Invalid Field: 'target'");
      return ranked(target, m, rec);
    };
    const d = await runStep(newRun(), researchStep(port), { context: consultancy, seeds });
    expect(d.competitors.find((c) => c.domain === "intratuin")).toBeUndefined();
    expect(d.competitors.find((c) => c.domain === "broken.nl")?.mined).toBe(false);
    expect(d.competitors.find((c) => c.domain === "niche.nl")?.mined).toBe(true);
    expect(d.warnings.join(" ")).toContain("broken.nl");

    port.rankedKeywords = async () => {
      const err = new Error("budget reached");
      err.name = "BudgetExceededError";
      throw err;
    };
    await expect(
      runStep(newRun(), researchStep(port), { context: consultancy, seeds }),
    ).rejects.toThrow("budget reached");
  });

  it("stops the run on a real data error instead of passing on a partial dataset", async () => {
    const port = stubPort({});
    port.serpOrganic = async () => {
      throw new Error("HTTP 500");
    };
    await expect(
      runStep(newRun(), researchStep(port), { context: consultancy, seeds }),
    ).rejects.toThrow("HTTP 500");
  });
});
