import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClientContext,
  type ClusterDetail,
  ClusterSet,
  type FilteredQuery,
  GateExpectations,
  type SiteMaps,
  SitePages,
  TopicalMap,
} from "@mycel/schema";
import { describe, expect, it } from "vitest";
import type { JsonModel } from "../context/llm.ts";
import { RunStore } from "../log/run-store.ts";
import { runStep } from "../step.ts";
import {
  finishMaps,
  isSectionPage,
  matchPages,
  type NodeLabel,
  ownBrand,
  type PageRef,
  pageIntent,
  planMaps,
  slugify,
} from "./build.ts";
import { checkGate, mapShape, shapeChecks } from "./gate.ts";
import { type LabelAnswer, mapStep } from "./label.ts";
import { buildLinkMessages, type LinkAnswer, linkablePages } from "./link.ts";

const fixture = (file: string) =>
  JSON.parse(readFileSync(join(__dirname, "../../../../fixtures/clients/plantpost", file), "utf8"));
const context = ClientContext.parse(fixture("context.json"));
const pages = SitePages.parse(fixture("pages.json")).pages;

const member = (query: string, volume = 100) => ({
  query,
  shared: 10,
  volume,
  scores: { relevance: 1, prominence: 0.5, popularity: 0.5 },
});

function cluster(
  id: string,
  label: "core" | "outer" | "bridge",
  queries: [string, number][],
  extra: Partial<ClusterDetail> = {},
): ClusterDetail {
  const members = queries.map(([q, v]) => member(q, v));
  return {
    id,
    mainQuery: queries[0]?.[0] as string,
    hub: queries[0]?.[0] as string,
    queries: queries.map(([q]) => q),
    sharedUrls: [],
    qdp: "page",
    outlier: false,
    label,
    entity: "kamerplant",
    members,
    demand: { volume: queries.reduce((s, [, v]) => s + v, 0), gscImpressions: 0 },
    aiOverview: { present: false, cited: false },
    serpFeatures: [],
    qdpWhy: "Its own results page, so its own page.",
    outlierReasons: [],
    ...extra,
  };
}

const clusters = ClusterSet.parse({
  site: context.site,
  market: context.market,
  minSharedUrls: 3,
  clusters: [
    cluster("kamerplanten", "core", [["kamerplanten", 9000]]),
    cluster("kopen", "core", [
      ["kamerplanten kopen", 4000],
      ["kamerplant bestellen", 900],
    ]),
    cluster("grote", "core", [
      ["grote kamerplant kopen", 1200],
      ["xl kamerplanten", 300],
    ]),
    cluster("pot", "core", [["plantenpot kopen", 2000]], { serpFeatures: ["shopping"] }),
    cluster("potmaat", "outer", [["plantenpot maat", 200]], {
      qdp: "section",
      hostClusterId: "pot",
    }),
    cluster("verpotten", "outer", [["kamerplant verpotten", 1500]], {
      serpFeatures: ["featured_snippet", "people_also_ask"],
    }),
    cluster("gele", "outer", [["gele bladeren kamerplant", 800]]),
    cluster("planten", "bridge", [["planten", 50000]]),
  ],
  unclustered: [],
  stats: {
    queries: 10,
    clustered: 10,
    clusters: 8,
    pages: 7,
    sections: 1,
    micro: 0,
    singletons: 6,
    outliers: 0,
    ambiguousMembers: 0,
    borderlineMembers: 0,
  },
});

const fq = (text: string, intent: FilteredQuery["intent"], cpc?: number): FilteredQuery =>
  ({
    text,
    normalized: text,
    sources: ["seed"],
    metrics: { volume: 100, ...(cpc !== undefined ? { cpc } : {}) },
    ...(intent ? { intent } : {}),
    filter: { kept: true },
  }) as FilteredQuery;

const queries: FilteredQuery[] = [
  fq("kamerplanten kopen", "transactional", 0.8),
  fq("kamerplant bestellen", "transactional", 0.4),
  fq("kamerplant verpotten", "informational"),
  fq("gele bladeren kamerplant", "informational"),
];

/**
 * A stub model. Label prompts: labels every page and picks hubs from a fixed list by page name.
 * Link prompts: each existing page picks a map page by URL override (a main query, or "none"),
 * else its first "likely" hint, the way a model that reads meaning would.
 */
function stub(
  hubs: Record<string, string> = {},
  links: Record<string, string> = { "/kamerplanten/xl-planten/": "grote kamerplant kopen" },
  also: Record<string, string> = {},
  group: (pages: { id: string; page: string }[]) => unknown = () => ({ groups: [] }),
): JsonModel & { calls: number; prompts: string[] } {
  const model = {
    calls: 0,
    prompts: [] as string[],
    async generateJson(
      req: { messages: { content: string }[] },
      schema: { parse: (v: unknown) => unknown },
    ) {
      model.calls++;
      const user = req.messages[1]?.content ?? "";
      model.prompts.push(user);
      if (user.includes("\nMap pages:\n")) return schema.parse(answerLinks(user, links, also));
      if (user.includes("\nPages under ")) {
        const list = JSON.parse(user.split(":\n").slice(-1)[0] ?? "[]") as {
          id: string;
          page: string;
        }[];
        return schema.parse(group(list));
      }
      const section = (name: string) => user.split(`\n${name}:\n`)[1]?.split("\n\n")[0] ?? "";
      const hubList = JSON.parse(section("Hubs") || "[]") as { id: string; page: string }[];
      const list = JSON.parse(user.split("\nPages:\n")[1] ?? "[]") as {
        i: number;
        page: string;
        topLevel?: boolean;
      }[];
      const results: LabelAnswer["results"] = list.map((p) => {
        const want = hubs[p.page];
        const hub = want === "root" ? "root" : hubList.find((h) => h.page === want)?.id;
        return {
          i: p.i,
          attribute: p.page,
          macroContext: `Over ${p.page}`,
          why: `Een eigen pagina voor ${p.page}.`,
          ...(p.topLevel && hub ? { parent: hub } : {}),
        };
      });
      return schema.parse({ results });
    },
  };
  return model as unknown as JsonModel & { calls: number; prompts: string[] };
}

/** Answers a link prompt: URL override by main query (or "none"), else the first hint. */
function answerLinks(
  user: string,
  links: Record<string, string>,
  also: Record<string, string> = {},
): LinkAnswer {
  const mapLines = (user.split("\nMap pages:\n")[1] ?? "").split("\n\n")[0] ?? "";
  const byQuery = new Map(
    mapLines
      .split("\n")
      .map((l) => /^(n\d+): (.*) \((?:home|core|outer)\)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[2] as string, m[1] as string]),
  );
  const existing = JSON.parse(user.split("\nExisting pages:\n")[1] ?? "[]") as {
    p: number;
    url: string;
    likely?: string[];
  }[];
  return {
    results: existing.map((e) => {
      const want = links[e.url];
      if (want === "none") return { p: e.p, node: "none" };
      const second = also[e.url] ? byQuery.get(also[e.url] as string) : undefined;
      return {
        p: e.p,
        node: (want && byQuery.get(want)) || e.likely?.[0] || "none",
        ...(second ? { also: second } : {}),
      };
    }),
  };
}

const newRun = () =>
  RunStore.create({
    runsDir: mkdtempSync(join(tmpdir(), "mycel-map-")),
    client: "test",
    command: "test",
    cliVersion: "0.0.0",
  });

async function build(hubs: Record<string, string> = {}): Promise<SiteMaps> {
  return runStep(newRun(), mapStep(stub(hubs)), {
    context,
    clusters,
    queries,
    pages,
    model: "fake",
  });
}

const node = (maps: SiteMaps, main: string) => {
  const n = maps.maps[0]?.nodes.find((x) => x.mainQuery === main);
  if (!n) throw new Error(`no node ${main}`);
  return n;
};

describe("slugify", () => {
  it("strips diacritics and joins words", () => {
    expect(slugify("Café kamerplant: wat kost één?")).toBe("cafe-kamerplant-wat-kost-een");
  });
});

describe("pageIntent", () => {
  it("weights member intents by volume", () => {
    const i = pageIntent(
      [
        { intent: "informational", volume: 100 },
        { intent: "transactional", volume: 900 },
      ],
      [],
      "outer",
    );
    expect(i).toEqual({ main: "transactional", mixed: false, source: "data" });
  });
  it("flags a close second intent as mixed", () => {
    const i = pageIntent(
      [
        { intent: "informational", volume: 500 },
        { intent: "commercial", volume: 450 },
      ],
      [],
      "core",
    );
    expect(i.mixed).toBe(true);
  });
  it("keeps navigational only for brand searches: local in a city market, else dropped", () => {
    const nav = [{ intent: "navigational", volume: 100 }];
    expect(pageIntent(nav, [], "core", { local: true }).main).toBe("local");
    expect(pageIntent(nav, [], "core").source).toBe("tier");
    expect(pageIntent(nav, [], "core", { brand: true }).main).toBe("navigational");
  });
  it("makes a core page that names an offering a service page", () => {
    const info = [{ intent: "informational", volume: 900 }];
    expect(pageIntent(info, [], "core", { offering: true })).toEqual({
      main: "commercial",
      mixed: true,
      source: "offering",
    });
    expect(pageIntent(info, [], "core", { offering: true, local: true }).main).toBe("local");
  });
  it("uses results-page features, then the tier", () => {
    expect(pageIntent([], ["shopping"], "outer").main).toBe("transactional");
    expect(pageIntent([], [], "core")).toEqual({
      main: "commercial",
      mixed: false,
      source: "tier",
    });
  });
});

describe("planMaps", () => {
  it("makes the entity's own page the root, nests pages by their words and skips bridges", () => {
    const plan = planMaps({ context, clusters, queries });
    const nodes = plan.entities[0]?.nodes ?? [];
    expect(nodes[0]?.isRoot).toBe(true);
    expect(nodes[0]?.mainQuery).toBe("kamerplanten");
    expect(nodes.some((n) => n.mainQuery === "planten")).toBe(false);
    const grote = nodes.find((n) => n.mainQuery === "grote kamerplant kopen");
    expect(grote?.parentId).toBe("n-kopen");
    expect(nodes.find((n) => n.mainQuery === "kamerplant verpotten")?.parentId).toBeUndefined();
    expect(
      nodes.find((n) => n.mainQuery === "plantenpot kopen")?.sections.map((s) => s.mainQuery),
    ).toEqual(["plantenpot maat"]);
  });

  it("folds brand searches into the root", () => {
    expect(
      ownBrand({
        site: { url: "https://www.desaak.com", name: "De Saak" },
        market: context.market,
      })("saak"),
    ).toBe(true);
    const set = ClusterSet.parse({
      ...clusters,
      clusters: [...clusters.clusters, cluster("brand", "core", [["plantpost", 700]])],
    });
    const nodes = planMaps({ context, clusters: set }).entities[0]?.nodes ?? [];
    expect(nodes.some((n) => n.mainQuery === "plantpost")).toBe(false);
    expect(nodes[0]?.queries).toContain("plantpost");
    expect(nodes[0]?.volume).toBe(9700);
  });

  it("folds pages with the same words into the bigger one", () => {
    const set = ClusterSet.parse({
      ...clusters,
      clusters: [
        ...clusters.clusters,
        cluster("verpot2", "outer", [["kamerplanten verpotten", 90]]),
      ],
    });
    const nodes = planMaps({ context, clusters: set }).entities[0]?.nodes ?? [];
    const verpotten = nodes.filter((n) => n.mainQuery.includes("verpotten"));
    expect(verpotten.map((n) => n.mainQuery)).toEqual(["kamerplant verpotten"]);
    expect(verpotten[0]?.queries).toContain("kamerplanten verpotten");
    expect(verpotten[0]?.volume).toBe(1590);
  });

  it("never puts a core page under an outer page", () => {
    const set = ClusterSet.parse({
      ...clusters,
      clusters: [
        cluster("verpotten", "outer", [["kamerplant verpotten", 1500]]),
        cluster("service", "core", [["kamerplant verpotten service", 300]]),
      ],
    });
    const nodes = planMaps({ context, clusters: set }).entities[0]?.nodes ?? [];
    expect(
      nodes.find((n) => n.mainQuery === "kamerplant verpotten service")?.parentId,
    ).toBeUndefined();
  });

  it("adds a root page when no cluster is just the entity", () => {
    const set = ClusterSet.parse({ ...clusters, clusters: clusters.clusters.slice(1) });
    const nodes = planMaps({ context, clusters: set }).entities[0]?.nodes ?? [];
    expect(nodes[0]).toMatchObject({
      id: "root-kamerplant",
      isRoot: true,
      mainQuery: "kamerplant",
    });
  });
});

describe("mapStep", () => {
  it("builds a valid map with intent, priority, quality nodes and a link plan", async () => {
    const maps = await build({ "gele bladeren kamerplant": "kamerplant verpotten" });
    const map = maps.maps[0] as SiteMaps["maps"][number];
    expect(TopicalMap.safeParse(map).success).toBe(true);
    expect(map.header.centralEntity.name).toBe("kamerplant");

    const root = node(maps, "kamerplanten");
    expect(root.level).toBe("root");
    expect(root.proposedUrl).toBe("/");
    expect(root.flags.quality).toBe(true);
    expect(root.linksOut.filter((l) => l.type === "from_home").length).toBeGreaterThanOrEqual(1);

    const kopen = node(maps, "kamerplanten kopen");
    expect(kopen.level).toBe("seed");
    expect(kopen.intent).toEqual({ main: "transactional", mixed: false, source: "data" });
    expect(kopen.demand.cpc).toBeCloseTo((0.8 * 4000 + 0.4 * 900) / 4900, 2);
    expect(kopen.why).toBe("Een eigen pagina voor kamerplanten kopen.");

    // The site's own category page makes this a locked hub under home, at its URL, even though
    // its words would nest it under "kamerplanten kopen".
    const grote = node(maps, "grote kamerplant kopen");
    expect(grote.hub).toBe("site");
    expect(grote.level).toBe("seed");
    expect(grote.proposedUrl).toBe("/kamerplanten/grote-kamerplanten/");

    const verpotten = node(maps, "kamerplant verpotten");
    expect(verpotten.section).toBe("outer");
    expect(verpotten.intent.main).toBe("informational");
    expect(verpotten.proposedUrl).toBe("/verzorging/kamerplant-verpotten/");
    expect(verpotten.status).toBe("exists_covered");

    // The model put an outer page under another outer page: it still links up to the core.
    const gele = node(maps, "gele bladeren kamerplant");
    expect(gele.parentId).toBe("n-verpotten");
    expect(gele.existingPage?.url).toBe("/verzorging/gele-bladeren/");
    expect(gele.linksOut.some((l) => l.type === "to_core" && l.to === root.id)).toBe(true);

    // Seeds bridge to each other.
    const pot = node(maps, "plantenpot kopen");
    expect(pot.linksOut.some((l) => l.type === "bridge")).toBe(true);
    expect(pot.intent.main).toBe("transactional");

    // Core money pages outrank supporting pages.
    expect(kopen.priority).toBeLessThanOrEqual(verpotten.priority);
  });

  it("links existing pages and flags the planted cannibalisation", async () => {
    const maps = await build();
    const grote = node(maps, "grote kamerplant kopen");
    expect(grote.conflict).toEqual({
      urls: expect.arrayContaining([
        "/kamerplanten/grote-kamerplanten/",
        "/kamerplanten/xl-planten/",
      ]),
      suggestion: "merge",
    });
    expect(grote.existingPage?.url).toBe("/kamerplanten/grote-kamerplanten/");
    expect(grote.status).toBe("exists_covered");
    expect(node(maps, "kamerplanten").existingPage?.url).toBe("/");
  });

  it("asks again when the model gives a top-level page no hub", async () => {
    let calls = 0;
    const model: JsonModel = {
      async generateJson(req, schema) {
        const user = req.messages[1]?.content ?? "";
        if (user.includes("\nMap pages:\n")) return schema.parse({ results: [] });
        calls++;
        const list = JSON.parse(user.split("\nPages:\n")[1] ?? "[]") as {
          i: number;
          page: string;
        }[];
        return schema.parse({
          results: list.map((p) => ({
            i: p.i,
            why: `Een pagina voor ${p.page}.`,
            parent: calls === 1 ? null : "root",
          })),
        });
      },
    };
    const maps = await runStep(newRun(), mapStep(model), {
      context,
      clusters,
      queries,
      pages,
      model: "fake",
    });
    expect(calls).toBe(2);
    expect(node(maps, "kamerplant verpotten").level).toBe("seed");
  });

  it('lets the model\'s "none" overrule a word match', async () => {
    const maps = await runStep(
      newRun(),
      mapStep(stub({}, { "/kamerplanten/grote-kamerplanten/": "none" })),
      { context, clusters, queries, pages, model: "fake" },
    );
    const grote = node(maps, "grote kamerplant kopen");
    expect(grote.existingPage?.url).toBe("/kamerplanten/xl-planten/");
    expect(grote.conflict).toBeFalsy();
  });

  it("puts a new outer page in its seed's folder", async () => {
    const maps = await runStep(
      newRun(),
      mapStep(
        stub(
          { "gele bladeren kamerplant": "kamerplant verpotten" },
          { "/verzorging/gele-bladeren/": "none" },
        ),
      ),
      { context, clusters, queries, pages, model: "fake" },
    );
    const gele = node(maps, "gele bladeren kamerplant");
    expect(gele.existingPage).toBeNull();
    expect(gele.proposedUrl).toBe("/kamerplant-verpotten/gele-bladeren-kamerplant/");
  });

  it("offers the site's own sections first as hubs, marked, and never asks to move them", async () => {
    const model = stub();
    await runStep(newRun(), mapStep(model), { context, clusters, queries, pages, model: "fake" });
    const label = model.prompts.find((p) => p.includes("\nHubs:\n")) ?? "";
    const hubs = JSON.parse(label.split("\nHubs:\n")[1]?.split("\n\n")[0] ?? "[]") as {
      page: string;
      site?: boolean;
    }[];
    expect(hubs.find((h) => h.page === "grote kamerplant kopen")?.site).toBe(true);
    const firstPlain = hubs.findIndex((h) => !h.site);
    expect(hubs.slice(firstPlain).some((h) => h.site)).toBe(false);
    expect(label).toContain('"siteHub": true');
  });

  it("turns a small supporting page with nothing under it into a section of its hub", async () => {
    const set = ClusterSet.parse({
      ...clusters,
      clusters: [
        ...clusters.clusters,
        cluster("tips", "outer", [["kamerplant verpotten tips", 10]]),
      ],
    });
    const maps = await runStep(newRun(), mapStep(stub()), {
      context,
      clusters: set,
      queries,
      pages,
      model: "fake",
    });
    expect(maps.maps[0]?.nodes.some((n) => n.mainQuery === "kamerplant verpotten tips")).toBe(
      false,
    );
    expect(node(maps, "kamerplant verpotten").sections.map((s) => s.mainQuery)).toContain(
      "kamerplant verpotten tips",
    );
  });

  it("flags a page that competes for a second map page as differentiate", async () => {
    const maps = await runStep(
      newRun(),
      mapStep(
        stub(
          {},
          { "/kamerplanten/xl-planten/": "kamerplanten kopen" },
          { "/kamerplanten/xl-planten/": "grote kamerplant kopen" },
        ),
      ),
      { context, clusters, queries, pages, model: "fake" },
    );
    expect(node(maps, "grote kamerplant kopen").conflict).toEqual({
      urls: ["/kamerplanten/grote-kamerplanten/", "/kamerplanten/xl-planten/"],
      suggestion: "differentiate",
    });
  });

  it("groups loose top-level pages under a new theme hub the model names", async () => {
    const extra = [
      "kamerplant weinig licht",
      "kamerplant volle zon",
      "kamerplant schaduw",
      "kamerplant cadeau",
      "kamerplant bezorgen",
      "kamerplant verjaardag",
      "kamerplant badkamer",
    ];
    const set = ClusterSet.parse({
      ...clusters,
      clusters: [
        ...clusters.clusters,
        ...extra.map((q, i) => cluster(`x${i}`, "core", [[q, 300]])),
      ],
    });
    const byName = (list: { id: string; page: string }[], ...names: string[]) =>
      names.map((n) => list.find((p) => p.page === n)?.id as string);
    const model = stub({}, undefined, {}, (list) => ({
      groups: [
        {
          name: "kamerplant kiezen",
          why: "Zo vind je de juiste plant voor elke plek in huis.",
          members: byName(
            list,
            "kamerplant weinig licht",
            "kamerplant volle zon",
            "kamerplant schaduw",
          ),
        },
        // Too small: dropped.
        { name: "cadeau", members: byName(list, "kamerplant cadeau", "kamerplant verjaardag") },
      ],
    }));
    const maps = await runStep(newRun(), mapStep(model), {
      context,
      clusters: set,
      queries,
      pages,
      model: "fake",
    });
    const theme = node(maps, "kamerplant kiezen");
    expect(theme).toMatchObject({ hub: "theme", level: "seed", section: "core" });
    expect(theme.why).toBe("Zo vind je de juiste plant voor elke plek in huis.");
    expect(node(maps, "kamerplant schaduw").parentId).toBe(theme.id);
    expect(node(maps, "kamerplant cadeau").level).toBe("seed");
    expect(TopicalMap.safeParse(maps.maps[0]).success).toBe(true);
  });

  it("names a site hub after its own page", async () => {
    const maps = await build();
    expect(node(maps, "grote kamerplant kopen").name).toBe(
      pages.find((p) => p.url === "/kamerplanten/grote-kamerplanten/")?.h1,
    );
  });

  it("keeps word matches when the model links nothing", async () => {
    const lazy: JsonModel = {
      async generateJson(req, schema) {
        const user = req.messages[1]?.content ?? "";
        const list = JSON.parse(user.split("\nPages:\n")[1] ?? "[]") as { i: number }[];
        return schema.parse({ results: list.map((p) => ({ i: p.i, parent: "root" })) });
      },
    };
    const maps = await runStep(newRun(), mapStep(lazy), {
      context,
      clusters,
      queries,
      pages,
      model: "fake",
    });
    expect(node(maps, "grote kamerplant kopen").existingPage?.url).toBe(
      "/kamerplanten/grote-kamerplanten/",
    );
  });

  it("ignores a hub choice that would put a core page under an outer page", async () => {
    const maps = await build({ "plantenpot kopen": "kamerplant verpotten" });
    expect(node(maps, "plantenpot kopen").level).toBe("seed");
  });

  it("stops when the model leaves pages unlabeled after a retry", async () => {
    const lazy: JsonModel = {
      async generateJson(_req, schema) {
        return schema.parse({ results: [] });
      },
    };
    await expect(
      runStep(newRun(), mapStep(lazy), { context, clusters, queries, pages, model: "fake" }),
    ).rejects.toThrow(/unlabeled after a retry/);
  });
});

describe("buildLinkMessages", () => {
  it("lists every map page and each existing page with its hints, skipping home and about", () => {
    const nodes = planMaps({ context, clusters, queries }).entities[0]?.nodes ?? [];
    const linkable = linkablePages(pages);
    expect(linkable.some((p) => p.url === "/")).toBe(false);
    const [system, user] = buildLinkMessages(
      context,
      "kamerplant",
      nodes,
      linkable.map((page) => ({ page, likely: ["n1"] })),
    );
    expect(system?.content).toContain('"none"');
    expect(user?.content).toContain("n0: kamerplanten (home)");
    expect(user?.content).toContain('"url": "/kamerplanten/xl-planten/"');
    expect(user?.content).toContain('"likely"');
  });
});

describe("matchPages", () => {
  it("needs the query to cover the page's H1, so one shared word isn't a match", () => {
    const nodes = planMaps({ context, clusters, queries }).entities[0]?.nodes ?? [];
    const found = matchPages(
      nodes,
      [
        { url: "/", kind: "home", title: "Plantpost", h1: "Kamerplanten" },
        {
          url: "/product/zamioculcas/",
          kind: "product",
          title: "Zamioculcas kopen | Plantpost",
          h1: "Zamioculcas zamiifolia",
        },
        {
          url: "/kamerplanten/grote-kamerplanten/",
          kind: "category",
          title: "Grote kamerplanten kopen | Plantpost",
          h1: "Grote kamerplanten",
        },
      ],
      context,
    );
    const all = [...found.values()].flat();
    expect(all).not.toContain("/product/zamioculcas/");
    expect(found.get("n-grote")).toEqual(["/kamerplanten/grote-kamerplanten/"]);
    expect(found.get(nodes[0]?.id as string)).toEqual(["/"]);
  });
});

describe("finishMaps", () => {
  it("falls back to data when a label is empty", () => {
    const plan = planMaps({ context, clusters, queries });
    const maps = finishMaps({
      plan,
      labels: new Map<string, NodeLabel>(),
      runId: "r",
      createdAt: "2026-11-14T12:00:00.000Z",
      costUsd: 0,
    });
    const n = maps.maps[0]?.nodes.find((x) => x.mainQuery === "kamerplant verpotten");
    expect(n?.why).toBe("Its own results page, so its own page.");
    expect(n?.rawNode).toEqual({ entity: "kamerplant", attribute: "kamerplant verpotten" });
  });
});

describe("isSectionPage", () => {
  it("knows section pages by kind, or by a folder of 3+ untyped pages without articles", () => {
    const pg = (url: string, kind: PageRef["kind"]): PageRef => ({
      url,
      kind,
      title: url,
      h1: url,
    });
    const site = [
      pg("/sectoren/bouw/", "other"),
      pg("/sectoren/handel/", "other"),
      pg("/sectoren/installatie/", "other"),
      pg("/kennisbank/erp-kiezen/", "blog"),
      pg("/kennisbank/dms/", "other"),
      pg("/kennisbank/planning/", "other"),
      pg("/kennisbank/btw/", "other"),
      pg("/over-ons/", "other"),
      pg("/diensten/", "service"),
    ];
    const yes = site.filter((p) => isSectionPage(p, site)).map((p) => p.url);
    expect(yes).toEqual([
      "/sectoren/bouw/",
      "/sectoren/handel/",
      "/sectoren/installatie/",
      "/diensten/",
    ]);
  });
});

describe("map shape", () => {
  it("counts hubs, childless hubs, site hubs kept and the widest page", async () => {
    const maps = await build();
    const nodes = maps.maps[0]?.nodes ?? [];
    const s = mapShape(nodes);
    expect(s.hubs).toBe(nodes.filter((n) => n.level === "seed").length);
    expect(s.siteHubs).toBeGreaterThanOrEqual(1);
    expect(s.siteHubsKept).toBe(s.siteHubs);
    const checks = shapeChecks(maps);
    expect(checks.map((c) => c.kind)).toEqual(["shape", "shape", "shape"]);
    expect(checks[2]?.status).toBe("pass");
  });
});

describe("checkGate", () => {
  const expectations = GateExpectations.parse(fixture("expectations.json"));
  it("passes core and outer queries in the right tier and finds the conflict", async () => {
    const maps = await build();
    const res = checkGate(maps, expectations, { language: "nl", queries });
    const byExpect = new Map(res.checks.map((c) => [c.expect, c]));
    expect(byExpect.get("kamerplanten kopen")?.status).toBe("pass");
    expect(byExpect.get("grote kamerplant kopen")?.status).toBe("pass");
    expect(byExpect.get("kamerplant verpotten")?.status).toBe("pass");
    expect(byExpect.get("hangplanten kopen")).toMatchObject({ status: "no data" });
    expect(byExpect.get("tuinplanten")?.status).toBe("pass");
    expect(res.checks.find((c) => c.kind === "conflict")?.status).toBe("pass");
  });
  it("fails a money query that landed in outer, and an off-topic page", async () => {
    const maps = await build();
    const wrong = GateExpectations.parse({
      ...expectations,
      expectedCore: ["kamerplant verpotten"],
      offTopic: ["verpotten"],
    });
    const res = checkGate(maps, wrong, { language: "nl", queries });
    expect(res.passed).toBe(false);
    expect(res.checks.find((c) => c.kind === "core")?.status).toBe("fail");
    expect(res.checks.find((c) => c.kind === "offTopic")?.status).toBe("fail");
  });
});
