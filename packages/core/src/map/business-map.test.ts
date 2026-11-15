import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BusinessProfile,
  ClientContext,
  type ClusterDetail,
  ClusterSet,
  TopicalMap,
} from "@mycel/schema";
import { describe, expect, it } from "vitest";
import type { ClusterSerp } from "../cluster/cluster.ts";
import type { JsonModel } from "../context/llm.ts";
import { RunStore } from "../log/run-store.ts";
import { runStep } from "../step.ts";
import { attachToBusiness, lockOfferingHubs } from "./attach.ts";
import { mergeSameIntent } from "./intent.ts";
import { planMaps, tokens } from "./plan.ts";
import { buildSkeleton, cellOf, covers, sameWord } from "./skeleton.ts";
import { mapStep } from "./step.ts";

// A neutral test business (not one of the test clients): a bike workshop.
const context = ClientContext.parse({
  site: { url: "https://fietsmaker.example", name: "Fietsmaker" },
  market: { country: "NL", language: "nl", city: "Zwolle" },
  sourceContext: "Fietsenmaker in Zwolle: reparatie, onderhoud en verhuur.",
  centralEntities: [{ name: "fiets", disambiguation: "tweewieler", notThis: [] }],
  centralSearchIntent: "een fiets laten repareren",
  audiences: [],
  offerings: ["fietsreparatie", "fietsverhuur"],
  competitors: [],
  answers: [],
  confirmed: { by: "test", at: "2026-11-15T10:00:00.000Z" },
});

const offering = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: "service",
  sources: [{ from: "owner" }],
  status: "confirmed",
  ...over,
});

const business = BusinessProfile.parse({
  offerings: [
    offering("fietsreparatie", "Fietsreparatie", {
      value: "top",
      subOfferings: ["band plakken", "Fietsmaker onderhoudsbeurt"],
      attributes: [{ name: "type", values: ["elektrische"] }],
    }),
    offering("fietsverhuur", "Fietsverhuur", { page: "/verhuur/" }),
  ],
  notOffered: [{ name: "fietslease", aliases: ["fiets lease"], sources: [{ from: "owner" }] }],
  places: { locations: [{ name: "Werkplaats", city: "Zwolle" }], serves: ["Zwolle"] },
  confirmed: { by: "test", at: "2026-11-15T10:00:00.000Z" },
});

const cluster = (
  id: string,
  label: "core" | "outer",
  queries: [string, number][],
): ClusterDetail => ({
  id,
  mainQuery: queries[0]?.[0] as string,
  hub: queries[0]?.[0] as string,
  queries: queries.map(([q]) => q),
  sharedUrls: [],
  qdp: "page",
  outlier: false,
  label,
  entity: "fiets",
  members: queries.map(([query, volume]) => ({
    query,
    shared: 10,
    volume,
    scores: { relevance: 1, prominence: 0.5, popularity: 0.5 },
  })),
  demand: { volume: queries.reduce((s, [, v]) => s + v, 0), gscImpressions: 0 },
  aiOverview: { present: false, cited: false },
  serpFeatures: [],
  qdpWhy: "Its own results page, so its own page.",
  outlierReasons: [],
});

const clusters = ClusterSet.parse({
  site: context.site,
  market: context.market,
  minSharedUrls: 3,
  clusters: [
    cluster("fiets", "core", [["fiets", 9000]]),
    cluster("reparatie", "core", [["fietsreparatie", 3000]]),
    cluster("kosten", "core", [["fietsreparatie kosten", 500]]),
    cluster("elektrisch", "core", [["elektrische fietsreparatie", 400]]),
    cluster("band", "outer", [["band plakken", 600]]),
    cluster("bandfiets", "outer", [["fietsband plakken", 300]]),
    cluster("lease", "core", [["fiets lease", 800]]),
    cluster("kopen", "core", [["fiets kopen", 2000]]),
    cluster("zwolle", "core", [["fiets zwolle", 900]]),
    cluster("ketting", "outer", [["fietsketting smeren", 700]]),
  ],
  unclustered: [],
  stats: {
    queries: 9,
    clustered: 9,
    clusters: 9,
    pages: 9,
    sections: 0,
    micro: 0,
    singletons: 9,
    outliers: 0,
    ambiguousMembers: 0,
    borderlineMembers: 0,
  },
});

const pages = [
  { url: "/", kind: "home" as const, title: "Home", h1: "Fietsmaker" },
  {
    url: "/verhuur/",
    kind: "service" as const,
    title: "Fiets huren",
    h1: "Fiets huren in Zwolle",
  },
];

const serp = (keyword: string, urls: string[]): ClusterSerp => ({
  keyword,
  organic: urls.map((u, i) => ({ rank: i + 1, key: u, urlSource: "url", domain: "x.nl" })),
  aiOverview: { present: false, references: [] },
});

describe("business skeleton", () => {
  it("makes cells from offerings, mines modifiers, and needs the offering for an attribute", () => {
    const sk = buildSkeleton(
      business,
      [
        "fietsreparatie kosten",
        "fietsreparatie kosten zwolle",
        "kosten fietsreparatie",
        "band plakken",
      ],
      "nl",
      "Fietsmaker",
    );
    expect(sk.cells.map((c) => c.id)).toEqual([
      "fietsreparatie",
      "fietsreparatie/band-plakken",
      "fietsreparatie/fietsmaker-onderhoudsbeurt",
      "fietsreparatie/elektrische",
      "fietsverhuur",
    ]);
    // The business's own name is not part of a key.
    expect([...(sk.cells[2]?.key ?? [])]).toEqual([...tokens("onderhoudsbeurt", "nl")]);
    expect(sk.modifiers.get("fietsreparatie")?.[0]?.word).toBe([...tokens("kosten", "nl")][0]);
    const t = (s: string) => tokens(s, "nl");
    expect(cellOf(t("elektrische fietsreparatie"), sk)?.id).toBe("fietsreparatie/elektrische");
    // The person who gives a service is the service ("fysiotherapeut" ~ "fysiotherapie").
    expect(sameWord("fysiotherapeut", "fysiotherapie")).toBe(true);
    expect(sameWord("projectbedrijf", "projectbeheer")).toBe(false);
    expect(sameWord("dakdekker", "dakdekking")).toBe(false);
    // A compound written apart is the same word.
    expect(covers(t("dak lekkage rotterdam"), t("daklekkage"))).toBe(true);
    // A bare attribute value without its offering is not claimed.
    expect(cellOf(t("elektrische auto"), sk)).toBeUndefined();
  });
});

describe("attachToBusiness", () => {
  it("gates the no-go list, demotes core pages that sell nothing, gives every offering a page", () => {
    const plan = planMaps({ context: { ...context, business }, clusters });
    const res = attachToBusiness(plan, business, pages);
    const nodes = plan.entities[0]?.nodes ?? [];
    const by = (q: string) => nodes.find((n) => n.mainQuery === q);
    expect([...res.gate]).toEqual([["n-lease", "off_offer"]]);
    expect(by("fiets kopen")?.section).toBe("outer");
    expect(by("fiets kopen")?.offeringId).toBeUndefined();
    // The central entity with a place the business serves stays core.
    expect(by("fiets zwolle")?.section).toBe("core");
    // The plain search is the offering's page; the more specific ones hang under it.
    expect(res.anchors.get("fietsreparatie")).toBe("n-reparatie");
    expect(by("fietsreparatie kosten")?.parentId).toBe("n-reparatie");
    expect(by("band plakken")?.offeringId).toBe("fietsreparatie");
    // No search names the rental: a new page, and the site's rental page belongs to it.
    const rental = res.anchors.get("fietsverhuur") as string;
    expect(rental).toBe("o-fietsverhuur");
    expect(by("fietsverhuur")?.hub).toBeUndefined();
    expect(res.pageLinks.get("/verhuur/")).toBe(rental);
    lockOfferingHubs(plan, res.anchors);
    expect(by("fietsverhuur")?.hub).toBe("offering");
    expect(res.stats).toMatchObject({ gated: 1, created: 1, demoted: 1 });
  });
});

describe("mergeSameIntent", () => {
  it("makes one page of two that share 3+ top-10 results, keeps offering pages, records proof", () => {
    const plan = planMaps({ context: { ...context, business }, clusters });
    const res = attachToBusiness(plan, business, pages);
    const serps = new Map([
      ["fietsreparatie", serp("fietsreparatie", ["a", "b", "c", "d"])],
      ["fietsreparatie kosten", serp("fietsreparatie kosten", ["a", "b", "c", "x"])],
      ["band plakken", serp("band plakken", ["p", "q", "r", "s"])],
      ["fietsband plakken", serp("fietsband plakken", ["p", "q", "r", "t"])],
      ["fiets kopen", serp("fiets kopen", ["k", "l", "m"])],
    ]);
    const merges = mergeSameIntent(plan, serps, new Set(res.anchors.values()));
    expect(merges.map((m) => [m.kept, m.folded, m.sharedUrls.length])).toEqual([
      ["n-reparatie", "n-kosten", 3],
      ["n-band", "n-bandfiets", 3],
    ]);
    const nodes = plan.entities[0]?.nodes ?? [];
    const rep = nodes.find((n) => n.id === "n-reparatie");
    expect(rep?.sections[0]).toMatchObject({
      mainQuery: "fietsreparatie kosten",
      sharedUrls: ["a", "b", "c"],
    });
    expect(rep?.volume).toBe(3500);
    expect(nodes.some((n) => n.id === "n-kosten")).toBe(false);
  });
});

/** A stub model: labels every page; names the offering of open pages by a fixed list. */
const prompts: string[] = [];

function stub(offers: Record<string, string> = {}): JsonModel {
  return {
    async generateJson(
      req: { messages: { content: string }[] },
      schema: { parse: (v: unknown) => unknown },
    ) {
      const user = req.messages[1]?.content ?? "";
      prompts.push(user);
      if (user.includes("\nMap pages:\n")) {
        const existing = JSON.parse(user.split("\nExisting pages:\n")[1] ?? "[]") as {
          p: number;
        }[];
        return schema.parse({ results: existing.map((e) => ({ p: e.p, node: "none" })) });
      }
      if (user.includes("\nConflicts:\n") || user.includes("\nPages under ")) {
        return schema.parse(user.includes("\nConflicts:\n") ? { results: [] } : { groups: [] });
      }
      const list = JSON.parse(user.split("\nPages:\n")[1] ?? "[]") as {
        i: number;
        page: string;
        topLevel?: boolean;
        pickOffering?: boolean;
      }[];
      return schema.parse({
        results: list.map((p) => ({
          i: p.i,
          attribute: p.page,
          macroContext: `Over ${p.page}`,
          why: `Een eigen pagina voor ${p.page}.`,
          name: p.page,
          ...(p.topLevel ? { parent: "root" } : {}),
          ...(p.pickOffering && offers[p.page] ? { offering: offers[p.page] } : {}),
        })),
      });
    },
  } as unknown as JsonModel;
}

describe("mapStep with a business profile", () => {
  it("ties every core page to an offering and leaves out what the business doesn't do", async () => {
    const run = RunStore.create({
      runsDir: mkdtempSync(join(tmpdir(), "mycel-bmap-")),
      client: "test",
      command: "test",
      cliVersion: "0.0.0",
    });
    const maps = await runStep(run, mapStep(stub({ "fietsketting smeren": "o0" })), {
      context: { ...context, business },
      clusters,
      pages,
      model: "fake",
    });
    const map = maps.maps[0] as (typeof maps.maps)[number];
    expect(TopicalMap.safeParse(map).success).toBe(true);
    expect(map.leftOut.map((l) => l.mainQuery)).toContain("fiets lease");
    // The gate's pages never reach the model.
    expect(prompts.some((p) => p.includes('"page": "fiets lease"'))).toBe(false);
    // Areas it serves are not locations: the model must not read "serves Zwolle" as a
    // location in every Zwolle neighbourhood.
    const labelPrompt = prompts.find((p) => p.includes("\nPages:\n")) ?? "";
    expect(labelPrompt).toContain('"servesAreas"');
    expect(labelPrompt).toMatch(/"locations": \[\s*"Werkplaats \(Zwolle\)"\s*\]/);
    // Every core page sells an offering, except the business itself in its town.
    const core = map.nodes.filter(
      (n) => n.section === "core" && n.level !== "root" && n.mainQuery !== "fiets zwolle",
    );
    expect(core.every((n) => n.offeringId)).toBe(true);
    // The offering page sits on the site's own rental page: a locked site section under home.
    const rental = map.nodes.find((n) => n.id === "o-fietsverhuur");
    expect(rental?.level).toBe("seed");
    expect(rental?.hub).toBe("site");
    expect(rental?.offeringId).toBe("fietsverhuur");
    expect(rental?.existingPage?.url).toBe("/verhuur/");
    // The model named the offering of a supporting page the words left open.
    expect(map.nodes.find((n) => n.mainQuery === "fietsketting smeren")?.offeringId).toBe(
      "fietsreparatie",
    );
  });

  it("plans existing pages first, ties the first plan to the top offering and fact-checks the texts", async () => {
    const run = RunStore.create({
      runsDir: mkdtempSync(join(tmpdir(), "mycel-bmap-")),
      client: "test",
      command: "test",
      cliVersion: "0.0.0",
    });
    const base = stub();
    const fixes: string[] = [];
    const llm = {
      async generateJson(
        req: { messages: { content: string }[] },
        schema: { parse: (v: unknown) => unknown },
      ) {
        const user = req.messages[1]?.content ?? "";
        if (user.includes("\nTexts:\n")) {
          const items = JSON.parse(user.split("\nTexts:\n")[1] ?? "[]") as { i: number }[];
          fixes.push(user);
          return schema.parse({
            results: items.map((it) => ({
              i: it.i,
              text: it.i === 0 ? "Wat een reparatie kost, voor wie twijfelt." : "De goedkoopste!",
            })),
          });
        }
        const out = (await (base.generateJson as (r: unknown, s: unknown) => Promise<unknown>)(
          req,
          schema,
        )) as {
          results?: { why?: string; name?: string; attribute?: string }[];
        };
        for (const r of out.results ?? []) {
          if (r.attribute === "fietsreparatie kosten")
            r.why = "De beste prijs van Zwolle, gegarandeerd.";
          if (r.attribute === "fietsketting smeren") r.name = "Ketting smeren in Deventer";
        }
        return out;
      },
    } as unknown as JsonModel;
    const maps = await runStep(run, mapStep(llm), {
      context: { ...context, business },
      clusters,
      pages,
      model: "fake",
    });
    const map = maps.maps[0] as (typeof maps.maps)[number];
    expect(TopicalMap.safeParse(map).success).toBe(true);
    // Fact check: one fix round; a fixed text is used, a fix that still fails gives way to data.
    expect(fixes).toHaveLength(1);
    expect(map.nodes.find((n) => n.mainQuery === "fietsreparatie kosten")?.why).toBe(
      "Wat een reparatie kost, voor wie twijfelt.",
    );
    expect(map.nodes.find((n) => n.mainQuery === "fietsketting smeren")?.name).toBe(
      "Fietsketting smeren",
    );
    // The first plan: numbered steps, each tied to the top offering (repairs) or a conflict.
    const now = map.nodes
      .filter((n) => n.wave === "now")
      .sort((a, b) => (a.planStep ?? 0) - (b.planStep ?? 0));
    expect(now.length).toBeGreaterThan(0);
    expect(now.map((n) => n.planStep)).toEqual(now.map((_, i) => i + 1));
    expect(now.every((n) => n.offeringId === "fietsreparatie" || n.action === "resolve")).toBe(
      true,
    );
    expect(map.nodes.filter((n) => n.level !== "root").every((n) => n.value !== undefined)).toBe(
      true,
    );
    // Every existing page has a job.
    expect(maps.inventory).toEqual([
      expect.objectContaining({ url: "/verhuur/", job: "serves", nodeId: "o-fietsverhuur" }),
    ]);
  });
});
