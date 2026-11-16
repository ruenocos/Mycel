import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientContext, Cluster, FilteredQuery } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import type { JsonModel } from "../context/llm.ts";
import {
  assignClusters,
  audiencePersonas,
  audienceStems,
  checkPersonas,
  personaPool,
  personaStage,
  proposePersonas,
} from "./personas.ts";

const context: ClientContext = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../../fixtures/clients/plantpost/context.json"),
    "utf8",
  ),
);

const q = (text: string, volume = 100, intent?: FilteredQuery["intent"]): FilteredQuery => ({
  text,
  normalized: text,
  sources: ["dfs_related"],
  metrics: { volume },
  ...(intent ? { intent } : {}),
  filter: { kept: true },
  scores: { relevance: 1, prominence: 1, popularity: 1 },
});

const queries = [
  q("veilige planten voor katten", 500, "informational"),
  q("giftige planten huisdieren", 300, "informational"),
  q("kamerplanten veilig voor honden", 200, "informational"),
  q("veilige kamerplant kopen", 90, "transactional"),
  q("monstera kopen", 900, "transactional"),
  q("grote kamerplant kopen", 700, "transactional"),
  q("kamerplant appartement weinig licht", 150, "informational"),
  q("planten voor op balkon appartement", 120, "informational"),
  q("kamerplanten voor kleine appartement", 80, "informational"),
  q("hoe vaak water geven monstera", 400, "informational"),
  q("plant opsturen naar iemand", 60, "transactional"),
  { ...q("tuinslang", 999), filter: { kept: false, reason: "off topic" } },
];

const cluster = (id: string, qs: string[]): Cluster => ({
  id,
  mainQuery: qs[0] as string,
  queries: qs,
  sharedUrls: [],
  qdp: "page",
  outlier: false,
});

describe("personas (step 1)", () => {
  it("reads the stage from what most of the searches' volume wants", () => {
    expect(personaStage([queries[0] as FilteredQuery, queries[4] as FilteredQuery])).toBe("buy");
    expect(personaStage([queries[0] as FilteredQuery, queries[1] as FilteredQuery])).toBe("learn");
    expect(personaStage([q("x")])).toBe("learn");
  });

  it("takes only telling words from an audience: not the core topic or 'mensen die'", () => {
    expect(audienceStems("mensen die een plant als cadeau sturen", context)).not.toContain("mens");
    const pet = audienceStems("huisdiereigenaren die een veilige plant zoeken", context);
    expect(pet.some((s) => s.startsWith("veilig"))).toBe(true);
    expect(pet.some((s) => s.startsWith("kamerplant"))).toBe(false);
  });

  it("without a model: an audience whose words three searches use is a persona", () => {
    const ps = audiencePersonas(context, queries);
    const pet = ps.find((p) => p.audience?.startsWith("huisdiereigenaren"));
    expect(pet).toMatchObject({ source: "audience", stage: "learn" });
    expect(pet?.evidence).toContain("veilige planten voor katten");
    expect(pet?.evidence).not.toContain("tuinslang");
    // "appartement" is in three searches: the city dwellers are a persona too.
    expect(ps.some((p) => p.audience?.startsWith("stedelingen"))).toBe(true);
  });

  it("shows the model audience searches and questions first, kept searches only", () => {
    const pool = personaPool(context, queries);
    expect(pool.map((x) => x.normalized)).not.toContain("tuinslang");
    expect(pool[0]?.normalized).toBe("veilige planten voor katten");
    expect(pool.map((x) => x.normalized)).toContain("hoe vaak water geven monstera");
  });

  it("keeps only what the searches prove, and only names and claims that pass the check", async () => {
    const pool = personaPool(context, queries);
    const at = (t: string) => pool.findIndex((x) => x.normalized === t);
    const seen: string[] = [];
    const llm = {
      async generateJson(
        req: { messages: { content: string }[] },
        schema: { parse: (v: unknown) => unknown },
      ) {
        seen.push(req.messages[1]?.content ?? "");
        return schema.parse({
          personas: [
            {
              name: "Huisdiereigenaar",
              who: "Heeft een kat of hond en zoekt de beste veilige plant.",
              audience: "huisdiereigenaren die een veilige plant zoeken",
              needs: ["veilige planten", "de beste plant"],
              evidence: [
                at("veilige planten voor katten"),
                at("giftige planten huisdieren"),
                at("kamerplanten veilig voor honden"),
                999,
              ],
              offerings: ["made-up"],
            },
            {
              // Its searches are taken already, and one is not there: too little proof.
              name: "Kattenmens",
              who: "Heeft katten.",
              audience: "kattenliefhebbers",
              needs: [],
              evidence: [at("veilige planten voor katten"), at("giftige planten huisdieren"), 998],
              offerings: [],
            },
            {
              name: "Stedeling met appartement",
              who: "Woont in een appartement en wil groen in huis.",
              audience: null,
              needs: ["planten voor weinig licht"],
              evidence: [
                at("kamerplant appartement weinig licht"),
                at("planten voor op balkon appartement"),
                at("kamerplanten voor kleine appartement"),
              ],
              offerings: [],
            },
          ],
        });
      },
    } as unknown as JsonModel;
    const drafts = await proposePersonas(llm, context, pool, { model: "m" }, {});
    expect(seen[0]).toContain("0. veilige planten voor katten (500, informational)");
    const ps = checkPersonas(drafts, pool, context);
    expect(ps.map((p) => p.id)).toEqual(["huisdiereigenaar", "stedeling-met-appartement"]);
    const [pet, city] = ps;
    // "beste" is praise the business can't back: the sentence becomes the audience.
    expect(pet?.who).toBe("huisdiereigenaren die een veilige plant zoeken");
    expect(pet?.needs).toEqual(["veilige planten"]);
    expect(pet?.offerings).toEqual([]);
    expect(pet?.evidence).toHaveLength(3);
    expect(pet?.volume).toBe(1000);
    expect(city).toMatchObject({ stage: "learn", source: "model" });
    expect(city?.audience).toBeUndefined();

    // Pages: by their searches in the evidence, or by the persona's own words; a tie is no one's.
    const out = assignClusters(
      ps,
      [
        cluster("c1", ["veilige planten voor katten", "giftige planten katten"]),
        cluster("c2", ["appartement planten schaduw"]),
        cluster("c3", ["monstera kopen"]),
        cluster("c4", ["veilige planten appartement"]),
        { ...cluster("c5", ["giftige planten huisdieren"]), qdp: "section" },
      ],
      context,
    );
    expect(out.map((p) => p.clusters)).toEqual([["c1"], ["c2"]]);
  });
});
