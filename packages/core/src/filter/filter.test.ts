import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientContext, type FilteredQuery, normalizeQuery, type Query } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import type { JsonModel } from "../context/llm.ts";
import { RunStore } from "../log/run-store.ts";
import { runStep } from "../step.ts";
import { buildClassifyMessages, type ClassifyAnswer, filterStep } from "./classify.ts";
import { scoreFilterEval } from "./eval.ts";
import { canonical, hasPhrase, mergeDuplicates, ruleFor, scoreQueries } from "./rules.ts";

const erp = ClientContext.parse({
  site: { url: "https://www.acme-erp.nl", name: "Acme ERP" },
  market: { country: "NL", language: "nl" },
  sourceContext: "Verdient aan implementatie van ERP-software.",
  centralEntities: [
    {
      name: "ERP",
      disambiguation: "Enterprise Resource Planning, bedrijfssoftware",
      notThis: ["erp gemeente", "erp noord-brabant"],
    },
  ],
  centralSearchIntent: "ERP kiezen",
  offerings: ["ERP implementatie"],
  competitors: ["exact.com"],
});

const q = (text: string, extra: Partial<Query> = {}): Query => ({
  text,
  normalized: normalizeQuery(text),
  sources: ["dfs_related"],
  metrics: {},
  ...extra,
});

const newRun = () =>
  RunStore.create({
    runsDir: mkdtempSync(join(tmpdir(), "mycel-filter-")),
    client: "test",
    command: "test",
    cliVersion: "0.0.0",
  });

/** A stub model with a fixed label per query text; records every batch it saw. */
function stub(
  labels: Record<string, ClassifyAnswer["results"][number]["label"]>,
  opts: { skipOnce?: string } = {},
): JsonModel & { batches: string[][] } {
  const batches: string[][] = [];
  let skipped = false;
  return {
    batches,
    async generateJson(req, schema) {
      const user = req.messages[1]?.content ?? "";
      const list = (user.split("\nQueries:\n")[1] ?? "")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.replace(/^\d+\. /, ""));
      batches.push(list);
      const results = list.flatMap((text, i) => {
        if (opts.skipOnce === text && !skipped) {
          skipped = true;
          return [];
        }
        const label = labels[text] ?? "outer";
        return [{ i, label, entity: label === "off" ? "" : "ERP", why: `stub ${label}` }];
      });
      return schema.parse({ results });
    },
  };
}

describe("rules", () => {
  it("folds case, accents and punctuation", () => {
    expect(canonical("Wat kost een Café?")).toBe("wat kost een cafe");
    expect(hasPhrase("Erp gemeente afval", "erp gemeente")).toBe(true);
    expect(hasPhrase("erpgemeente", "erp gemeente")).toBe(false);
  });

  it("drops junk, addresses, not-this and own brand, but trusts no detected language", () => {
    const rule = (text: string, extra: Partial<Query> = {}) => ruleFor(q(text, extra), erp)?.rule;
    expect(rule("123 456")).toBe("junk");
    expect(rule("a b c d e f g h i j k")).toBe("junk");
    expect(rule("exact.com inloggen")).toBe("navigational");
    // DataforSEO's language guess is unreliable on short queries; never a reason to drop.
    expect(rule("erp software kosten", { language: "fi" })).toBeUndefined();
    expect(rule("ERP gemeente openingstijden")).toBe("not this");
    expect(rule("acme erp ervaringen")).toBe("own brand");
    expect(rule("erp software kosten", { language: "nl" })).toBeUndefined();
  });

  it("merges near-duplicates into the one with most volume", () => {
    const { queries, merged } = mergeDuplicates([
      q("erp kosten?", { sources: ["serp_paa"], metrics: { gscImpressions: 40 } }),
      q("ERP kosten", { metrics: { volume: 320 } }),
      q("erp systeem"),
    ]);
    expect(merged).toBe(1);
    const head = queries.find((x) => x.text === "ERP kosten") as FilteredQuery;
    expect(head.filter).toBeUndefined();
    expect(head.sources).toEqual(["dfs_related", "serp_paa"]);
    expect(head.metrics).toEqual({ volume: 320, gscImpressions: 40 });
    expect(queries.find((x) => x.text === "erp kosten?")?.filter).toEqual({
      kept: false,
      reason: 'duplicate of "ERP kosten"',
    });
  });

  it("scores relevance, prominence and popularity on 0..1", () => {
    const qs: FilteredQuery[] = [
      {
        ...q("a", {
          sources: ["seed", "serp_paa", "dfs_related", "dfs_ranked_competitor"],
          metrics: { volume: 1000 },
        }),
        label: "core",
        filter: { kept: true },
      },
      {
        ...q("b", { sources: ["dfs_related", "dfs_suggestions"], metrics: { volume: 9 } }),
        label: "outer",
        filter: { kept: true },
      },
      { ...q("c"), label: "off", filter: { kept: false } },
    ];
    scoreQueries(qs);
    expect(qs[0]?.scores).toEqual({ relevance: 1, prominence: 1, popularity: 1 });
    expect(qs[1]?.scores).toEqual({ relevance: 0.6, prominence: 0.25, popularity: 0.333 });
    expect(qs[2]?.scores).toBeUndefined();
  });
});

describe("filterStep", () => {
  it("runs rules first, labels the rest, and keeps dropped queries with a reason", async () => {
    const llm = stub({ "erp boxtel": "off", "wat is erp": "outer", "erp implementatie": "core" });
    const out = await runStep(newRun(), filterStep(llm), {
      context: erp,
      site: erp.site,
      model: "m",
      queries: [
        q("erp implementatie", { metrics: { volume: 500 } }),
        q("Erp implementatie!"),
        q("wat is erp", { metrics: { volume: 50 } }),
        q("erp boxtel"),
        q("erp gemeente"),
        q("acme erp login"),
      ],
    });
    expect(llm.batches).toEqual([["erp implementatie", "wat is erp", "erp boxtel"]]);
    const by = (t: string) => out.queries.find((x) => x.text === t);
    expect(by("erp implementatie")).toMatchObject({
      label: "core",
      entity: "ERP",
      filter: { kept: true },
    });
    expect(by("erp implementatie")?.scores?.relevance).toBe(1);
    expect(by("erp boxtel")?.filter).toEqual({ kept: false, reason: "off topic: stub off" });
    expect(by("erp gemeente")?.filter?.reason).toBe("not this: erp gemeente");
    expect(out.stats).toEqual({
      total: 6,
      kept: 2,
      dropped: { duplicate: 1, "not this": 1, "own brand": 1, off: 1 },
    });
  });

  it("asks again for queries the model skipped, in small batches", async () => {
    const llm = stub({}, { skipOnce: "erp b" });
    const out = await runStep(newRun(), filterStep(llm), {
      context: erp,
      site: erp.site,
      model: "m",
      batchSize: 2,
      queries: [q("erp a"), q("erp b"), q("erp c")],
    });
    expect(llm.batches).toEqual([["erp a", "erp b"], ["erp c"], ["erp b"]]);
    expect(out.stats.kept).toBe(3);
  });

  it("stops the run when the model keeps skipping a query", async () => {
    const llm: JsonModel = {
      async generateJson(_req, schema) {
        return schema.parse({ results: [] });
      },
    };
    await expect(
      runStep(newRun(), filterStep(llm), {
        context: erp,
        site: erp.site,
        model: "m",
        queries: [q("erp a")],
      }),
    ).rejects.toThrow('unlabeled after a retry, e.g. "erp a"');
  });

  it("tells the model the meaning, the look-alikes and, for local clients, the city", () => {
    const local = ClientContext.parse({ ...erp, market: { ...erp.market, city: "Utrecht" } });
    const [system, user] = buildClassifyMessages(local, ["erp boxtel"]);
    expect(system?.content).toContain("another town or city");
    expect(system?.content).toContain("Dutch");
    expect(user?.content).toContain("Enterprise Resource Planning");
    expect(user?.content).toContain("0. erp boxtel");
  });
});

describe("scoreFilterEval", () => {
  it("scores keep as the positive class and lists misses with the filter's reason", () => {
    const s = scoreFilterEval(
      {
        client: "t",
        cases: [
          { query: "a", expect: "keep", why: "x" },
          { query: "b", expect: "keep", why: "x" },
          { query: "c", expect: "drop", why: "x" },
          { query: "d", expect: "drop", why: "x" },
        ],
      },
      {
        site: erp.site,
        market: erp.market,
        stats: { total: 4, kept: 2, dropped: {} },
        queries: [
          {
            ...q("a"),
            filter: { kept: true },
            scores: { relevance: 1, prominence: 0, popularity: 0 },
          },
          { ...q("b"), filter: { kept: false, reason: "off topic" } },
          {
            ...q("c"),
            filter: { kept: true },
            scores: { relevance: 1, prominence: 0, popularity: 0 },
          },
          { ...q("d"), filter: { kept: false } },
        ],
      },
    );
    expect(s).toMatchObject({ accuracy: 0.5, precision: 0.5, recall: 0.5 });
    expect(s.misses.map((m) => [m.query, m.got, m.reason ?? null])).toEqual([
      ["b", "drop", "off topic"],
      ["c", "keep", null],
    ]);
  });
});
