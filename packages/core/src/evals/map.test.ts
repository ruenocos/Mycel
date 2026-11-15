import type { ClientContext, MapNode, SiteMaps } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import type { ClusterSerp } from "../cluster/cluster.ts";
import { evalMap } from "./map.ts";
import { mapDigest, mapReviewPrompt } from "./map-review.ts";

const context: ClientContext = {
  site: { url: "https://praktijk.example", name: "Praktijk" },
  market: { country: "NL", language: "nl", city: "Utrecht" },
  sourceContext: "Fysiotherapiepraktijk in Utrecht.",
  centralEntities: [{ name: "fysiotherapie", disambiguation: "behandeling", notThis: [] }],
  centralSearchIntent: "een fysiotherapeut vinden",
  audiences: [],
  offerings: ["fysiotherapie", "dry needling"],
  competitors: [],
  answers: [],
};

const node = (id: string, over: Partial<MapNode> = {}): MapNode => ({
  id,
  section: "core",
  level: "node",
  parentId: "root",
  rawNode: { entity: "fysiotherapie", attribute: id },
  macroContext: id,
  mainQuery: id.replace(/-/g, " "),
  queries: [],
  sections: [],
  intent: { main: "commercial", mixed: false, source: "data" },
  proposedUrl: `/${id}/`,
  existingPage: null,
  demand: {},
  priority: 3,
  action: "create",
  flags: { quality: false, trending: false },
  linksOut: [],
  aiOverview: null,
  status: "idea",
  why: "A plain reason for this page.",
  ...over,
});

const maps = (nodes: MapNode[], outside: SiteMaps["outside"] = []): SiteMaps => ({
  site: "https://praktijk.example",
  maps: [
    {
      header: {
        site: "https://praktijk.example",
        runId: "r",
        createdAt: "2026-11-15T10:00:00.000Z",
        sourceContext: "x",
        centralEntity: context.centralEntities[0] as ClientContext["centralEntities"][number],
        centralSearchIntent: "x",
        costUsd: 0,
      },
      nodes: [node("root", { level: "root", parentId: undefined }), ...nodes],
      leftOut: [],
    },
  ],
  outside,
});

const serp = (keyword: string, urls: string[]): ClusterSerp => ({
  keyword,
  organic: urls.map((u, i) => ({ rank: i + 1, key: u, urlSource: "url", domain: "x.nl" })),
  aiOverview: { present: false, references: [] },
});

const run = (m: SiteMaps, ctx = context, serps = new Map<string, ClusterSerp>()) =>
  evalMap({
    maps: m,
    context: ctx,
    pages: [
      { url: "/", kind: "home", title: "Home", h1: "Home" },
      { url: "/dry-needling/", kind: "service", title: "Dry needling", h1: "Dry needling" },
      { url: "/blog/rugpijn/", kind: "blog", title: "Rugpijn", h1: "Rugpijn" },
    ],
    serps,
    createdAt: "2026-11-15T10:00:00.000Z",
  });

describe("evalMap", () => {
  it("counts page pairs whose searches share 3+ top-10 results", () => {
    const serps = new Map([
      ["fysiotherapie utrecht", serp("fysiotherapie utrecht", ["a", "b", "c", "d"])],
      ["fysio utrecht", serp("fysio utrecht", ["a", "b", "c", "x"])],
      ["dry needling", serp("dry needling", ["a", "y", "z"])],
    ]);
    const e = run(
      maps([node("fysiotherapie-utrecht"), node("fysio-utrecht"), node("dry-needling")]),
      context,
      serps,
    );
    expect(e.metrics.duplicateIntentPairs.value).toBe(1);
    expect(e.metrics.duplicateIntentPairs.examples[0]).toContain("3 shared");
  });

  it("leaves the overlap number empty without SERPs", () => {
    expect(run(maps([node("dry-needling")])).metrics.duplicateIntentPairs.value).toBeNull();
  });

  it("flags core pages without an offering, using offeringId first", () => {
    const e = run(
      maps([
        node("dry-needling"),
        node("kaakfysiotherapie"),
        node("schouderklachten", { offeringId: "fysiotherapie" }),
      ]),
    );
    expect(e.metrics.coreWithoutOffering.value).toBe(1);
    expect(e.metrics.coreWithoutOffering.examples).toEqual(["kaakfysiotherapie"]);
  });

  it("uses the business profile: no-go list and top offerings", () => {
    const ctx: ClientContext = {
      ...context,
      business: {
        offerings: [
          {
            id: "dry-needling",
            name: "dry needling",
            kind: "service",
            subOfferings: [],
            attributes: [],
            audiences: [],
            places: [],
            proofPoints: [],
            value: "top",
            sources: [{ from: "site", ref: "/dry-needling/", confidence: "high" }],
            unknown: [],
            status: "confirmed",
          },
          {
            id: "fysiotherapie",
            name: "fysiotherapie",
            kind: "service",
            subOfferings: [],
            attributes: [],
            audiences: [],
            places: [],
            proofPoints: [],
            value: "normal",
            sources: [{ from: "site", confidence: "high" }],
            unknown: [],
            status: "confirmed",
          },
        ],
        notOffered: [
          {
            name: "kaakfysiotherapie",
            aliases: ["kaakfysio"],
            sources: [{ from: "owner", confidence: "high" }],
          },
        ],
        places: { locations: [], serves: [], nationwide: false },
        differentiators: [],
        facts: [],
        brand: { own: [], neverTarget: [], avoidWords: [] },
        siteTerms: [],
        openQuestions: [],
      },
    };
    const e = run(
      maps([
        node("dry-needling", { wave: "now" }),
        node("fysiotherapie-utrecht", { wave: "now" }),
        node("kaakfysio", { wave: "later" }),
        node("dry-needling-kosten", { wave: "now", action: "resolve" }),
      ]),
      ctx,
    );
    expect(e.withProfile).toBe(true);
    expect(e.metrics.notOfferedPages.value).toBe(1);
    expect(e.metrics.nowNotTied.examples).toEqual(["fysiotherapie utrecht"]);
  });

  it("ties a page to an offering by its site page or by the name without the brand", () => {
    const offering = {
      kind: "service" as const,
      subOfferings: [],
      attributes: [],
      audiences: [],
      places: [],
      proofPoints: [],
      value: "top" as const,
      sources: [{ from: "site" as const, confidence: "high" as const }],
      unknown: [],
      status: "confirmed" as const,
    };
    const ctx: ClientContext = {
      ...context,
      business: {
        offerings: [
          { ...offering, id: "praktijk-planner", name: "Praktijk Planner", page: "/planner/" },
          { ...offering, id: "praktijk-taping", name: "Praktijk Taping" },
        ],
        notOffered: [],
        places: { locations: [], serves: [], nationwide: false },
        differentiators: [],
        facts: [],
        brand: { own: [], neverTarget: [], avoidWords: [] },
        siteTerms: [],
        openQuestions: [],
      },
    };
    const e = run(
      maps([
        node("agenda-tool", {
          existingPage: { url: "https://praktijk.example/planner/", matchScore: 1 },
        }),
        node("taping"),
      ]),
      ctx,
    );
    expect(e.metrics.coreWithoutOffering.value).toBe(0);
  });

  it("counts outside pages with a planned twin and existing pages with a job", () => {
    const e = run(
      maps(
        [
          node("rugpijn", { section: "outer", action: "create" }),
          node("dry-needling", {
            action: "keep",
            existingPage: { url: "/dry-needling/", matchScore: 1 },
          }),
        ],
        [{ url: "/blog/rugpijn/", kind: "blog", title: "Rugpijn" }],
      ),
    );
    expect(e.metrics.outsideWithTwin.value).toBe(1);
    expect(e.metrics.existingWithJob.value).toBe(0.5);
    expect(e.metrics.newPages.value).toBe(1);
  });

  it("writes a review prompt with the rubric and the first plan", () => {
    const m = maps([node("dry-needling", { wave: "now", name: "Dry needling" })]);
    expect(mapDigest(m, context)).toContain("[create] Dry needling /dry-needling/");
    const prompt = mapReviewPrompt("owner", m, context);
    expect(prompt).toContain("the owner of this business");
    expect(prompt).toContain('"overall"');
  });
});
