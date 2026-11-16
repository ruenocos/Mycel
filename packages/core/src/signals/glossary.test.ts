import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientContext, FilteredQuery } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import type { JsonModel } from "../context/llm.ts";
import {
  buildGlossary,
  type EntityLike,
  entityCheck,
  pageTerms,
  pickExact,
  pickItems,
  termCandidates,
} from "./glossary.ts";

const context: ClientContext = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../../fixtures/clients/plantpost/context.json"),
    "utf8",
  ),
);

const q = (text: string, volume = 100): FilteredQuery => ({
  text,
  normalized: text,
  sources: ["dfs_related"],
  metrics: { volume },
  filter: { kept: true },
  scores: { relevance: 1, prominence: 1, popularity: 1 },
});

const queries = [
  q("monstera kopen", 900),
  q("monstera verzorgen", 400),
  q("monstera verpotten", 300),
  q("monstera deliciosa", 500),
  q("gatenplant kopen", 200),
  q("kamerplant water geven", 300),
  q("kamerplanten water geven", 100),
  q("hoe vaak kamerplant water geven", 80),
  q("plantpost kortingscode", 50),
  { ...q("tuinplant kopen"), filter: { kept: false, reason: "not this" } },
];

describe("glossary terms (step 7)", () => {
  it("takes domain words from kept searches, not buying words, the brand or dropped searches", () => {
    const terms = termCandidates(context, queries);
    const names = terms.map((t) => t.term);
    expect(names).toContain("monstera");
    // Spelling forms are one term, written as searched most.
    expect(names.filter((t) => t.startsWith("kamerplant "))).toEqual(["kamerplant water"]);
    // "water" alone holds no search the pair doesn't: the pair says it.
    expect(names).not.toContain("water");
    for (const no of ["kopen", "hoe", "plantpost", "tuinplant", "kortingscode"]) {
      expect(names).not.toContain(no);
    }
    // The central entity and the offerings are always in, searched or not.
    expect(names).toContain("kamerplant");
    expect(names).toContain("hangplanten");
    expect(terms.find((t) => t.term === "monstera")).toMatchObject({ queries: 4, volume: 2100 });
  });

  it("picks a Wikidata item only from what was offered; without a model only exact names", async () => {
    const items = [
      {
        term: "monstera",
        candidates: [
          { id: "Q10", label: "Monstera", description: "geslacht uit de aronskelkfamilie" },
          { id: "Q11", label: "Monstera", description: "Brits schip" },
        ],
      },
      {
        term: "erp",
        candidates: [{ id: "Q20", label: "Erp", description: "dorp in Noord-Brabant" }],
      },
    ];
    expect(pickExact(items)).toEqual(new Map([["erp", "Q20"]]));
    const seen: string[] = [];
    const llm = {
      async generateJson(
        req: { messages: { content: string }[] },
        schema: { parse: (v: unknown) => unknown },
      ) {
        seen.push(req.messages[1]?.content ?? "");
        return schema.parse({
          results: [
            { i: 0, id: "Q10" },
            { i: 1, id: "Q999" },
          ],
        });
      },
    } as unknown as JsonModel;
    const picked = await pickItems(llm, context, items, { model: "m" }, {});
    expect(picked).toEqual(new Map([["monstera", "Q10"]]));
    expect(seen[0]).toContain('"notThis"');
  });

  it("builds entries with sourced meaning, other names people searched, and related terms", () => {
    const terms = termCandidates(context, queries);
    const e: EntityLike = {
      id: "Q10",
      label: "Monstera",
      description: "geslacht uit de aronskelkfamilie",
      aliases: ["gatenplant", "Monstera"],
      broader: ["plantengeslacht"],
      parts: [],
      partOf: ["aronskelkfamilie"],
    };
    const g = buildGlossary({
      terms,
      picked: new Map([["monstera", "Q10"]]),
      entities: new Map([["Q10", e]]),
      queries,
      language: "nl",
    });
    expect(g.find((x) => x.term === "monstera")).toMatchObject({
      wikidata: { id: "Q10", description: "geslacht uit de aronskelkfamilie" },
      synonyms: ["gatenplant"],
      searchedAs: ["gatenplant"],
      broader: ["plantengeslacht"],
      partOf: ["aronskelkfamilie"],
    });
    expect(pageTerms(["monstera verpotten"], g, "nl")).toEqual(["monstera", "gatenplant"]);
    expect(pageTerms(["citroenboom"], g, "nl")).toEqual([]);
  });

  it("says whether the central entity is a known thing, and what that means for the map", () => {
    expect(entityCheck("kamerplant", undefined, true)).toMatchObject({ recognized: false });
    expect(entityCheck("kamerplant", undefined, false).note).toMatch(/Not checked/);
    const known = entityCheck(
      "kamerplant",
      {
        id: "Q1",
        label: "kamerplant",
        aliases: ["potplant"],
        broader: ["plant"],
        parts: [],
        partOf: [],
        wikipedia: "https://nl.wikipedia.org/wiki/Kamerplant",
      },
      true,
    );
    expect(known).toMatchObject({
      recognized: true,
      wikidata: { id: "Q1" },
      aliases: ["potplant"],
      broader: ["plant"],
    });
  });
});
