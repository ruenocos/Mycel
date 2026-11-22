import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Brief,
  BusinessProfile,
  type ClientContext,
  type MapNode,
  type SerpSnapshot,
  type SignalSet,
  SiteMaps,
} from "@mycel/schema";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { JsonModel } from "../context/llm.ts";
import { RunStore } from "../log/run-store.ts";
import { runStep } from "../step.ts";
import {
  type BriefAnswer,
  type BriefInput,
  buildBriefMessages,
  estimateBriefTokens,
} from "./prompt.ts";
import {
  briefSources,
  evidenceFor,
  findPage,
  firstPlanPages,
  linksFor,
  questionsFor,
  resultsFor,
  targetsFor,
} from "./sources.ts";
import { assembleBrief, BRIEF_STEP_VERSION, briefStep, unbackedNumbers } from "./step.ts";

// Synthetic test clients only (fixtures/README.md): nothing here is real client data.
const fixtures = join(import.meta.dirname, "../../../../fixtures/clients");
const json = (client: string, file: string) =>
  JSON.parse(readFileSync(join(fixtures, client, file), "utf8"));
const withBusiness = (client: string): ClientContext => {
  const { $comment: _c, ...key } = json(client, "business.key.json");
  return { ...json(client, "context.json"), business: BusinessProfile.parse(key) };
};
const plantpost = withBusiness("plantpost");

const node = (over: Partial<MapNode> & Pick<MapNode, "id" | "mainQuery">): MapNode => ({
  section: "core",
  level: "node",
  rawNode: { entity: "kamerplant", attribute: over.mainQuery },
  macroContext: "Houseplants",
  queries: [over.mainQuery],
  sections: [],
  intent: { main: "transactional", mixed: false, source: "data" },
  proposedUrl: `/kamerplanten/${over.id}/`,
  existingPage: null,
  demand: {},
  priority: 2,
  action: "create",
  flags: { quality: false, trending: false },
  linksOut: [],
  aiOverview: null,
  status: "idea",
  why: "People search for this before they buy a plant.",
  ...over,
});

const root = node({
  id: "root-kamerplant",
  mainQuery: "kamerplanten",
  level: "root",
  proposedUrl: "/",
});
const page = node({
  id: "n-grote",
  mainQuery: "grote kamerplant kopen",
  name: "Grote kamerplanten",
  parentId: root.id,
  offeringId: "grote-kamerplanten",
  queries: ["grote kamerplant kopen", "hoe groot wordt een monstera", "xxl kamerplanten"],
  sections: [
    {
      clusterId: "c9",
      mainQuery: "grote kamerplant weinig licht",
      qdp: "section",
      queries: [],
      volume: 90,
    },
  ],
  existingPage: { url: "/kamerplanten/grote-kamerplanten/", matchScore: 0.9 },
  action: "improve",
  wave: "now",
  planStep: 1,
  linksOut: [{ to: root.id, type: "to_core" }],
  terms: ["monstera"],
});
const sibling = node({
  id: "n-xxl",
  mainQuery: "xxl kamerplanten",
  parentId: root.id,
  wave: "now",
  planStep: 2,
  linksOut: [{ to: page.id, type: "sibling", anchor: "grote kamerplanten" }],
});
const maps = SiteMaps.parse({
  site: "plantpost.example",
  maps: [
    {
      header: {
        site: "plantpost.example",
        runId: "2026-11-20T09-12-00Z-a1b2",
        createdAt: "2026-11-20T09:40:00.000Z",
        sourceContext: plantpost.sourceContext,
        centralEntity: plantpost.centralEntities[0],
        centralSearchIntent: plantpost.centralSearchIntent,
        costUsd: 0,
      },
      nodes: [root, page, sibling],
    },
  ],
});

const serp: SerpSnapshot = {
  keyword: "grote kamerplant kopen",
  organic: [
    {
      rank: 2,
      key: "b",
      url: "https://groenthuis.example/xxl",
      domain: "groenthuis.example",
      title: "XXL kamerplanten",
    },
    {
      rank: 1,
      key: "a",
      url: "https://plantenwinkel.example/groot",
      domain: "plantenwinkel.example",
      title: "Grote kamerplanten kopen",
    },
    {
      rank: 3,
      key: "c",
      url: "https://plantpost.example/x",
      domain: "www.plantpost.example",
      title: "Plantpost",
    },
  ],
  aiOverview: { present: false, references: [] },
  peopleAlsoAsk: [
    "Welke grote kamerplant heeft weinig licht nodig?",
    "hoe groot wordt een monstera",
  ],
  relatedSearches: ["grote kamerplant weinig licht", "kunstplant groot"],
};

const signals = {
  competitors: {
    sites: [],
    coverage: [],
    gaps: [
      { topic: "monstera verpotten", competitors: ["a.example", "b.example"], pages: 4, urls: [] },
      { topic: "bonsai snoeien", competitors: ["a.example", "b.example"], pages: 4, urls: [] },
    ],
  },
} as unknown as SignalSet;

describe("brief sources", () => {
  it("finds a page by id, URL or main search, and the first plan in order", () => {
    expect(findPage(maps, "n-grote")?.node.id).toBe("n-grote");
    expect(findPage(maps, "/kamerplanten/grote-kamerplanten/")?.node.id).toBe("n-grote");
    expect(findPage(maps, "Grote Kamerplant Kopen")?.node.id).toBe("n-grote");
    expect(findPage(maps, "nope")).toBeUndefined();
    expect(firstPlanPages(maps, 5).map((n) => n.id)).toEqual(["n-grote", "n-xxl"]);
  });

  it("takes facts only from the business profile, each with its source", () => {
    const offering = plantpost.business?.offerings.find((o) => o.id === "grote-kamerplanten");
    const evidence = evidenceFor(plantpost, offering);
    expect(evidence.map((e) => e.id)).toEqual(evidence.map((_, i) => `e${i + 1}`));
    expect(evidence[0]).toEqual({
      id: "e1",
      fact: "Planten zelf uitgezocht bij kwekers in het Westland",
      source: { kind: "business", ref: "facts.0" },
      check: { state: "unchecked" },
    });
    expect(evidence.map((e) => e.fact)).toContain(
      "grote kamerplanten, hoogte: vanaf 80 cm, 80 tot 180 cm",
    );
    // A nationwide webshop gets no place facts; facts of other offerings stay out.
    expect(evidence.some((e) => e.fact.includes("Werkgebied"))).toBe(false);
    expect(evidence.some((e) => e.fact.includes("keramiek"))).toBe(false);
    expect(evidenceFor({ ...plantpost, business: undefined } as unknown as ClientContext)).toEqual(
      [],
    );
  });

  it("cites the site's page when the profile does, and names a local business's places", () => {
    const b = plantpost.business as BusinessProfile;
    const cited = {
      ...plantpost,
      business: {
        ...b,
        facts: [
          {
            fact: "Voor 16:00 besteld, morgen in huis",
            sources: [{ from: "site" as const, ref: "/", confidence: "high" as const }],
          },
        ],
      },
    };
    expect(evidenceFor(cited)[0]?.source).toEqual({
      kind: "url",
      url: "https://plantpost.example/",
    });

    const physio = evidenceFor(withBusiness("praktijk-beweegruimte")).map((e) => e.fact);
    expect(physio).toContain("Werkgebied: Lombok, Leidsche Rijn, Utrecht West");
    expect(physio).toContain("Locatie: Lombok, Utrecht");
  });

  it("collects questions as they were found: people also ask, searches, related, gaps", () => {
    const qs = questionsFor(page, [serp], "nl", signals);
    expect(qs).toEqual([
      { question: "Welke grote kamerplant heeft weinig licht nodig?", from: "people_also_ask" },
      { question: "hoe groot wordt een monstera", from: "search" },
      { question: "kunstplant groot", from: "related_search" },
      { question: "monstera verpotten", from: "gap" },
    ]);
  });

  it("lists the top results without the client's own, and the links both ways", () => {
    expect(resultsFor(page, [serp], plantpost.site.url).map((r) => r.rank)).toEqual([1, 2]);
    const map = maps.maps[0] as SiteMaps["maps"][number];
    expect(linksFor(map, page)).toEqual([
      {
        direction: "to",
        nodeId: root.id,
        url: "/",
        name: "kamerplanten",
        type: "to_core",
        anchor: "kamerplanten",
      },
      {
        direction: "from",
        nodeId: "n-xxl",
        url: "/kamerplanten/n-xxl/",
        name: "xxl kamerplanten",
        type: "sibling",
        anchor: "grote kamerplanten",
      },
    ]);
  });

  it("sets targets from the intent and the sections on the page", () => {
    expect(targetsFor(page)).toEqual({
      words: 850,
      keyword: { term: "grote kamerplant kopen", uses: 3 },
      readingLevel: "B1",
    });
    const informational = {
      ...page,
      intent: { ...page.intent, main: "informational" as const },
      sections: [],
    };
    expect(targetsFor(informational).words).toBe(1200);
  });
});

const sources = briefSources({ context: plantpost, maps, serps: [serp], signals }, "n-grote");
const input = (over: Partial<BriefInput> = {}): BriefInput => ({
  ...sources,
  context: plantpost,
  previous: [],
  now: "2026-11-21T10:00:00.000Z",
  model: "test-model",
  ...over,
});

const answer = (over: Partial<BriefAnswer> = {}): BriefAnswer => ({
  coreMessage: "Een grote kamerplant geeft direct sfeer; kies hem op hoogte.",
  reader: {
    searchesFor: "Een grote plant voor de woonkamer.",
    feels: "Enthousiast, maar onzeker of hij het overleeft.",
    doesNext: "Kiest een plant en bestelt hem.",
  },
  difference: "De toppers tonen lijsten; deze pagina helpt kiezen op hoogte.",
  outline: [
    {
      level: "h3",
      heading: "Welke maat past?",
      purpose: "Helpt kiezen.",
      form: "table",
      points: ["van 80 tot 180 cm", "70% van de kopers kiest groot"],
      evidence: ["e4", "e99"],
      words: 300,
    },
    {
      level: "h1",
      heading: "Grote kamerplanten kopen",
      purpose: "Zegt wat de lezer vindt.",
      form: "prose",
      points: [],
      evidence: [],
      words: 100,
    },
    {
      level: "h2",
      heading: "Zo komt je plant thuis",
      purpose: "Neemt twijfel weg.",
      form: "infographic",
      points: ["met verzorgingskaartje"],
      evidence: ["e2"],
      words: 100,
    },
  ],
  avoid: ["tuinplanten", "tuinplanten", ""],
  questions: [0, 0, 3, 42],
  links: [{ i: 1, anchor: "grote kamerplanten bestellen" }],
  cta: "Kies je plant en bestel hem.",
  ...over,
});

describe("brief prompt", () => {
  it("is in English, asks for the market language and shows only the data", () => {
    const [system, user] = buildBriefMessages(input());
    expect(system?.content).toContain("Write every text in Dutch (nl)");
    expect(system?.content).toContain("use only the numbered evidence");
    expect(user?.content).toContain("e1: Planten zelf uitgezocht bij kwekers in het Westland");
    expect(user?.content).toContain(
      "0. Welke grote kamerplant heeft weinig licht nodig? [people_also_ask]",
    );
    expect(user?.content).toContain("1. Grote kamerplanten kopen (plantenwinkel.example)");
    expect(user?.content).toContain(
      'about 850 words, the main search "grote kamerplant kopen" about 3 times',
    );
  });

  it("counts the tokens of a brief for the dry run without calling a model", () => {
    const t = estimateBriefTokens(input());
    expect(t.input).toBeGreaterThan(800);
    expect(t.output).toBe(2000);
  });
});

describe("assembleBrief", () => {
  const brief = Brief.parse(assembleBrief(input(), answer(), "run-1"));

  it("writes a valid version 2 brief tied to the map's research and the run", () => {
    expect(brief.version).toBe(2);
    expect(brief.research).toEqual({
      runId: "2026-11-20T09-12-00Z-a1b2",
      createdAt: "2026-11-20T09:40:00.000Z",
    });
    expect(brief.made).toEqual({
      runId: "run-1",
      stepVersion: BRIEF_STEP_VERSION,
      model: "test-model",
      prompt: { id: "brief", version: "1" },
    });
    expect(brief.page).toMatchObject({
      nodeId: "n-grote",
      url: "/kamerplanten/grote-kamerplanten/",
      action: "improve",
    });
    expect(brief.cta).toEqual({ action: "Kies je plant en bestel hem.", conversion: "buy" });
  });

  it("puts the outline in shape and spreads the words over it", () => {
    expect(brief.outline.map((h) => `${h.level} ${h.heading}`)).toEqual([
      "h1 Grote kamerplanten kopen",
      "h2 Welke maat past?",
      "h2 Zo komt je plant thuis",
    ]);
    expect(brief.outline[2]?.form).toBe("prose");
    expect(brief.targets.headings).toBe(2);
    expect(brief.outline.reduce((n, h) => n + h.words, 0)).toBe(850);
  });

  it("keeps only facts it was given, and drops a point with a made-up number", () => {
    expect(brief.outline[1]?.evidence).toEqual(["e4"]);
    expect(brief.outline[1]?.points).toEqual(["van 80 tot 180 cm"]);
    expect(brief.evidence.map((e) => e.id)).toEqual(["e2", "e4"]);
    expect(brief.warnings.join("\n")).toContain("pointed at evidence that isn't there: e99");
    expect(brief.warnings.join("\n")).toContain("1 outline point(s) dropped");
  });

  it("picks questions and anchors from the lists only", () => {
    expect(brief.questions.map((q) => q.question)).toEqual([
      "Welke grote kamerplant heeft weinig licht nodig?",
      "monstera verpotten",
    ]);
    expect(brief.links.map((l) => l.anchor)).toEqual([
      "kamerplanten",
      "grote kamerplanten bestellen",
    ]);
    expect(brief.avoid).toEqual(["tuinplanten"]);
  });

  it("flags a claim the business can't back for a person, instead of passing it on quietly", () => {
    const b = Brief.parse(
      assembleBrief(
        input(),
        answer({ coreMessage: "De beste grote planten voor €19,95." }),
        "run-1",
      ),
    );
    expect(b.warnings.join("\n")).toMatch(
      /check the core message: .*price 19,95 not in the profile/,
    );
  });

  it("carries a person's check over when the fact and its source stay the same", () => {
    const checked = { state: "checked" as const, by: "Wons", at: "2026-11-21T11:00:00.000Z" };
    const e2 = sources.evidence.find((e) => e.id === "e2");
    const e4 = sources.evidence.find((e) => e.id === "e4");
    const previous = [
      { ...(e2 as (typeof sources.evidence)[number]), id: "e7", check: checked },
      { ...(e4 as (typeof sources.evidence)[number]), fact: "a fact that changed", check: checked },
    ];
    const b = Brief.parse(assembleBrief(input({ previous }), answer(), "run-1"));
    expect(b.evidence.map((e) => e.check.state)).toEqual(["checked", "unchecked"]);
  });

  it("finds numbers no source has", () => {
    expect(unbackedNumbers("van 80 tot 180 cm, 70% kiest", "vanaf 80 cm, 80 tot 180 cm")).toEqual([
      "70",
    ]);
  });
});

describe("briefStep", () => {
  /** A stub model: the test decides the answers, nothing is called or paid for. */
  const stub = (answers: unknown[]) => {
    const requests: { model: string; template: { id: string } }[] = [];
    const llm: JsonModel = {
      async generateJson<S extends z.ZodType>(
        req: { model: string; template: { id: string; version: string } },
        schema: S,
      ) {
        requests.push(req);
        return schema.parse(answers.shift()) as z.output<S>;
      },
    };
    return { llm, requests };
  };
  const run = () =>
    RunStore.create({
      runsDir: mkdtempSync(join(tmpdir(), "mycel-brief-")),
      client: "plantpost.example",
      command: "brief",
      cliVersion: "0",
    });

  it("makes one model call per page and validates what comes back", async () => {
    const { llm, requests } = stub([answer()]);
    const r = run();
    const brief = await runStep(r, briefStep(llm, "n-grote"), input());
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: "test-model", template: { id: "brief" } });
    expect(brief.made.runId).toBe(r.runId);
    expect(Brief.safeParse(brief).success).toBe(true);
  });

  it("asks again when an answer can't make a brief (an empty message)", async () => {
    const { llm, requests } = stub([answer({ coreMessage: " " }), answer()]);
    const brief = await runStep(run(), briefStep(llm, "n-grote"), input());
    expect(requests).toHaveLength(2);
    expect(brief.coreMessage).toContain("grote kamerplant");
  });
});
