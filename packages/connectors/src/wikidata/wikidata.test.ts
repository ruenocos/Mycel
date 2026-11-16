import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nullRecorder } from "../recorder.ts";
import { parseEntities, WikidataClient, WikidataError } from "./client.ts";

/** Made-up items in Wikidata's shape. */
const ENTITY = {
  entities: {
    Q1: {
      id: "Q1",
      labels: { nl: { value: "kamerplant" } },
      descriptions: { nl: { value: "plant die binnenshuis wordt gehouden" } },
      aliases: { nl: [{ value: "potplant" }, { value: "binnenplant" }] },
      claims: {
        P279: [{ mainsnak: { datavalue: { value: { id: "Q2" } } } }],
        P527: [{ mainsnak: { datavalue: { value: { id: "Q3" } } } }],
      },
      sitelinks: { nlwiki: { title: "Kamer plant" } },
    },
    Q9: { id: "Q9", missing: "" },
  },
};
const LABELS = {
  entities: {
    Q2: { id: "Q2", labels: { nl: { value: "plant" } } },
    Q3: { id: "Q3", labels: { en: { value: "leaf" } } },
  },
};
const SEARCH = {
  search: [
    { id: "Q1", label: "kamerplant", description: "plant die binnenshuis wordt gehouden" },
    { id: "Q5", label: "Kamer", description: "dorp", match: { text: "kamer plant" } },
  ],
};

describe("wikidata (steps 3 and 7)", () => {
  it("reads labels, descriptions, aliases, relations and the Wikipedia article", () => {
    expect(parseEntities(ENTITY, "nl")).toEqual([
      {
        id: "Q1",
        label: "kamerplant",
        description: "plant die binnenshuis wordt gehouden",
        aliases: ["potplant", "binnenplant"],
        broaderIds: ["Q2"],
        partIds: ["Q3"],
        partOfIds: [],
        wikipedia: "https://nl.wikipedia.org/wiki/Kamer_plant",
      },
    ]);
  });

  it("searches, reads entities with named relations, and caches every answer", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url.searchParams.get("action") ?? "");
      expect(url.searchParams.get("maxlag")).toBe("5");
      if (url.searchParams.get("action") === "wbsearchentities")
        return new Response(JSON.stringify(SEARCH));
      return new Response(
        JSON.stringify(url.searchParams.get("props") === "labels" ? LABELS : ENTITY),
      );
    };
    const cacheDir = mkdtempSync(join(tmpdir(), "mycel-wd-"));
    const client = () => new WikidataClient({ cacheDir, fetchImpl, sleep: async () => {} });
    expect(await client().search("kamerplant", "nl", nullRecorder)).toEqual([
      { id: "Q1", label: "kamerplant", description: "plant die binnenshuis wordt gehouden" },
      { id: "Q5", label: "Kamer", description: "dorp", matched: "kamer plant" },
    ]);
    const [e] = await client().entities(["Q1"], "nl", nullRecorder);
    expect(e).toMatchObject({ id: "Q1", broader: ["plant"], parts: ["leaf"], partOf: [] });
    expect(calls).toEqual(["wbsearchentities", "wbgetentities", "wbgetentities"]);
    await client().entities(["Q1"], "nl", nullRecorder);
    expect(calls).toHaveLength(3);
  });

  it("turns an API error into a WikidataError with the reason", async () => {
    const client = new WikidataClient({
      fetchImpl: async () => new Response(JSON.stringify({ error: { info: "maxlag" } })),
      sleep: async () => {},
    });
    await expect(client.search("x", "nl", nullRecorder)).rejects.toThrow(WikidataError);
    await expect(client.search("x", "nl", nullRecorder)).rejects.toThrow(/maxlag/);
  });
});
