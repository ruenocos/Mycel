import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResearchPort } from "@mycel/core";
import { ResearchDataset } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import { research } from "./research.ts";

const fixture = (name: string) => join(import.meta.dirname, "../../../fixtures/clients", name);
const tmp = () => mkdtempSync(join(tmpdir(), "mycel-cli-research-"));

const port: ResearchPort = {
  relatedKeywords: async (seed) => [{ keyword: `${seed} kopen`, volume: 100 }],
  keywordSuggestions: async (seed) => [{ keyword: `${seed} goedkoop` }],
  rankedKeywords: async (d) => [{ keyword: `${d} kw`, position: 2 }],
  competitorDomains: async () => [],
  serpOrganic: async (keyword) => ({
    keyword,
    organic: ["groen.nl", "plantje.nl", "youtube.com"].map((d, i) => ({
      rank: i + 1,
      title: d,
      key: `${d}/`,
      url: `https://${d}/`,
      domain: d,
    })),
    aiOverview: { present: false, references: [] },
    peopleAlsoAsk: [`hoe verzorg je ${keyword}?`],
    relatedSearches: [],
  }),
};

describe("mycel research", () => {
  it("refuses an unconfirmed context unless it's a dry run", async () => {
    await expect(
      research({
        runsDir: join(tmp(), "runs"),
        contextFile: join(fixture("plantpost"), "context.json"),
        provider: "fake",
        model: "m",
        env: {},
        port,
      }),
    ).rejects.toThrow("isn't confirmed");
  });

  it("builds a dataset for a fixture and names competitors the context doesn't have", async () => {
    const dir = tmp();
    const ctxFile = join(dir, "context.json");
    writeFileSync(ctxFile, readFileSync(join(fixture("plantpost"), "context.json")));
    const res = await research({
      runsDir: join(dir, "runs"),
      contextFile: ctxFile,
      site: fixture("plantpost"),
      provider: "fake",
      model: "m",
      noModel: true,
      allowUnconfirmed: true,
      env: {},
      port,
    });
    expect(res.ok).toBe(true);
    const d = ResearchDataset.parse(JSON.parse(readFileSync(join(dir, "research.json"), "utf8")));
    expect(d.seeds.map((s) => s.text)).toContain("kamerplant");
    expect(d.queries.some((q) => q.normalized === "kamerplant kopen")).toBe(true);
    expect(d.pages.length).toBeGreaterThan(5);
    const text = res.lines.join("\n");
    expect(text).toContain("dry run");
    expect(text).toContain("groen.nl (");
    expect(text).not.toContain("youtube.com (");
    expect(res.timeline).toContain("research-collect");
  });
});
