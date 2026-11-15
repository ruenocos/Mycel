import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetExceededError, FakeProvider } from "@mycel/connectors";
import { type ResearchPort, RunStore, readRunMeta, summarizeRun } from "@mycel/core";
import { ResearchDataset } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import { research } from "./research.ts";

const fixture = (name: string) => join(import.meta.dirname, "../../../fixtures/clients", name);
const tmp = () => mkdtempSync(join(tmpdir(), "mycel-cli-research-"));

/** A central entity of the Plantpost fixture: a model seed has to name one. */
const ENTITY = "kamerplant";

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
    expect(text).toContain("trial run");
    expect(text).toContain("groen.nl (");
    expect(text).not.toContain("youtube.com (");
    const steps = readRunMeta(join(dir, "runs"), res.runId ?? "").steps.map((s) => s.name);
    expect(steps).toContain("research-collect");
    expect(res.next).toEqual([{ command: `mycel filter ${join(dir, "research.json")}` }]);
  });

  const setup = () => {
    const dir = tmp();
    const contextFile = join(dir, "context.json");
    writeFileSync(contextFile, readFileSync(join(fixture("plantpost"), "context.json")));
    return {
      dir,
      runsDir: join(dir, "runs"),
      base: {
        runsDir: join(dir, "runs"),
        contextFile,
        site: fixture("plantpost"),
        cacheDir: join(dir, "cache"),
        provider: "fake",
        model: "m",
        allowUnconfirmed: true,
        env: {},
      },
    };
  };

  it("--resume continues a failed run: the steps it finished are not done again", async () => {
    const { runsDir, base } = setup();
    // The budget runs out while collecting: sources and seeds are done, the dataset is not.
    const broke: ResearchPort = {
      ...port,
      relatedKeywords: async () => {
        throw new BudgetExceededError("budget of $1 reached");
      },
    };
    // The model answers once. A second question would find the script empty and fail the run.
    const model = new FakeProvider([
      JSON.stringify({ seeds: [{ query: "grote kamerplant kopen", ref: ENTITY }] }),
    ]);
    const first = await research({ ...base, port: broke, llmProviders: [model] });
    expect(first.ok).toBe(false);
    expect(first.retry).toContain(`--resume ${first.runId}`);
    const before = summarizeRun(runsDir, first.runId ?? "");
    expect(before.steps.find((s) => s.name === "research-seeds")).toMatchObject({
      status: "ok",
      llmCalls: 1,
    });

    const second = await research({ ...base, port, llmProviders: [model], resume: "latest" });
    expect(second.ok).toBe(true);
    expect(model.requests).toHaveLength(1);
    expect(second.runId).not.toBe(first.runId);
    const after = summarizeRun(runsDir, second.runId ?? "");
    const step = (name: string) => after.steps.find((s) => s.name === name);
    // The seeds are the first run's own, so no model call: new seeds would miss the cache.
    expect(step("research-seeds")).toMatchObject({ llmCalls: 0, reusedFrom: first.runId });
    expect(step("research-sources")).toMatchObject({ reusedFrom: first.runId });
    expect(step("research-collect")?.reusedFrom).toBeUndefined();
    expect(readRunMeta(runsDir, second.runId ?? "").config.resumedFrom).toContain(first.runId);
    expect(existsSync(join(base.contextFile, "..", "research.json"))).toBe(true);
  });

  it("--resume refuses a run of another client or another command", async () => {
    const { runsDir, base } = setup();
    const other = RunStore.create({
      runsDir,
      client: "elders.example",
      command: "research",
      cliVersion: "0",
    });
    other.finish();
    await expect(research({ ...base, port, resume: other.runId })).rejects.toMatchObject({
      code: "INPUT_INVALID",
      message: expect.stringContaining("not a research run for plantpost.example"),
    });
    await expect(research({ ...base, port, resume: "nope" })).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
    });
    // Refused before anything started: no new run was created for it.
    expect(summarizeRun(runsDir, other.runId).runId).toBe(other.runId);
    expect(readRunMeta(runsDir, other.runId).status).toBe("ok");
  });

  it("--dry-run says what the last run cost and where this one would stop, and does nothing", async () => {
    const { dir, runsDir, base } = setup();
    const fresh = await research({ ...base, port, dryRun: true, budgetUsd: 2 });
    expect(fresh.ok).toBe(true);
    expect(fresh.runId).toBeUndefined();
    const text = fresh.lines.join("\n");
    expect(text).toContain("nothing is bought and no file is written");
    expect(text).toContain("can't be counted up front");
    expect(text).toContain("last time   no earlier research run for plantpost.example");
    expect(text).toContain("ceiling     --budget 2: buying stops there (this month $0.00 of $50)");
    for (const path of ["runs", "research.json", "cache"]) {
      expect(existsSync(join(dir, path)), path).toBe(false);
    }

    const real = await research({ ...base, port, noModel: true });
    const again = await research({ ...base, port, dryRun: true });
    const line = again.lines.find((l) => l.startsWith("last time")) ?? "";
    expect(line).toContain("last time   $0.0000 on ");
    expect(line).toContain("(ok)");
    expect(again.lines.join("\n")).toContain(`run ${real.runId}`);
    // Still nothing new on disk: the dry run did not add a run.
    expect(readRunMeta(runsDir, real.runId ?? "").status).toBe("ok");
  });
});
