import { describe, expect, it } from "vitest";
import {
  ClientContext,
  Cluster,
  type MapNode,
  normalizeQuery,
  Query,
  TopicalMap,
} from "./index.ts";

// Synthetic fixture (Plantpost is a fictional test client), so it may live in the repo.
const context = {
  site: { url: "https://plantpost.example", name: "Plantpost" },
  market: { country: "NL", language: "nl" },
  sourceContext: "Webshop that sells houseplants by mail",
  centralEntities: [{ name: "kamerplant", disambiguation: "houseplant", notThis: ["tuinplant"] }],
  centralSearchIntent: "buy and care for houseplants",
};

const node = (over: Partial<MapNode> & Pick<MapNode, "id">): MapNode => ({
  section: "core",
  level: "node",
  rawNode: { entity: "kamerplant", attribute: "verzorging" },
  macroContext: "Houseplant care",
  mainQuery: "kamerplant verzorgen",
  queries: [],
  sections: [],
  intent: { main: "informational", mixed: false, source: "data" },
  proposedUrl: "/kamerplanten/verzorging/",
  existingPage: null,
  demand: {},
  priority: 2,
  action: "create",
  wave: "now",
  flags: { quality: false, trending: false },
  linksOut: [],
  aiOverview: null,
  status: "idea",
  why: "People search how to keep plants alive before they buy more.",
  ...over,
});

const header = {
  site: "plantpost.example",
  runId: "2026-11-13T00-00-00Z-abcd",
  createdAt: "2026-11-13T00:00:00Z",
  sourceContext: context.sourceContext,
  centralEntity: context.centralEntities[0],
  centralSearchIntent: context.centralSearchIntent,
  costUsd: 1.2,
};

describe("ClientContext", () => {
  it("accepts a minimal context and fills defaults", () => {
    const parsed = ClientContext.parse(context);
    expect(parsed.competitors).toEqual([]);
    expect(parsed.centralEntities[0]?.notThis).toEqual(["tuinplant"]);
  });

  it("rejects bad market codes and missing entities", () => {
    expect(
      ClientContext.safeParse({ ...context, market: { country: "nl", language: "NL" } }).success,
    ).toBe(false);
    expect(ClientContext.safeParse({ ...context, centralEntities: [] }).success).toBe(false);
  });

  it("supports a local market with a city", () => {
    const local = { ...context, market: { country: "NL", language: "nl", city: "Utrecht" } };
    expect(ClientContext.parse(local).market.city).toBe("Utrecht");
  });
});

describe("Query and Cluster", () => {
  it("normalizes query text", () => {
    expect(normalizeQuery("  Kamerplant   VERZORGEN ")).toBe("kamerplant verzorgen");
  });

  it("requires at least one source", () => {
    expect(Query.safeParse({ text: "x", normalized: "x", sources: [] }).success).toBe(false);
    expect(Query.parse({ text: "x", normalized: "x", sources: ["gsc"] }).metrics).toEqual({});
  });

  it("knows page, section and micro clusters", () => {
    const c = Cluster.parse({
      id: "c1",
      mainQuery: "a",
      queries: ["a"],
      qdp: "section",
      hostClusterId: "c0",
    });
    expect(c.outlier).toBe(false);
    expect(Cluster.safeParse({ id: "c1", mainQuery: "a", queries: [], qdp: "page" }).success).toBe(
      false,
    );
  });
});

describe("TopicalMap checks", () => {
  const root = node({ id: "root", level: "root", proposedUrl: "/" });
  const core = node({ id: "care", parentId: "root" });
  const outer = node({
    id: "history",
    section: "outer",
    parentId: "root",
    proposedUrl: "/kamerplanten/geschiedenis/",
    linksOut: [{ to: "care", type: "to_core" }],
  });

  it("accepts a valid map", () => {
    expect(TopicalMap.safeParse({ header, nodes: [root, core, outer] }).success).toBe(true);
  });

  it("requires every outer node to link to a core node", () => {
    const lonely = { ...outer, linksOut: [] };
    const r = TopicalMap.safeParse({ header, nodes: [root, core, lonely] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/must link to a core node/);
  });

  it("catches duplicate ids, unknown links and a missing root", () => {
    const r = TopicalMap.safeParse({
      header,
      nodes: [core, { ...core }, { ...outer, linksOut: [{ to: "ghost", type: "to_core" }] }],
    });
    const messages = r.error?.issues.map((i) => i.message).join("\n") ?? "";
    expect(messages).toMatch(/duplicate id care/);
    expect(messages).toMatch(/unknown node ghost/);
    expect(messages).toMatch(/needs a root/);
  });

  it("catches a parent loop", () => {
    const a = node({ id: "a", parentId: "b" });
    const b = node({ id: "b", parentId: "a" });
    const r = TopicalMap.safeParse({ header, nodes: [node({ id: "r", level: "root" }), a, b] });
    expect(r.error?.issues.map((i) => i.message).join("\n")).toMatch(/parent loop/);
  });

  it("insists on a plain-language why and a clean slug", () => {
    expect(TopicalMap.safeParse({ header, nodes: [{ ...root, why: "because" }] }).success).toBe(
      false,
    );
    expect(
      TopicalMap.safeParse({ header, nodes: [{ ...root, proposedUrl: "/Kamer Planten" }] }).success,
    ).toBe(false);
  });
});
