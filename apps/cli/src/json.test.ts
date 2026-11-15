import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliOutput, MAP_TARGETS } from "@mycel/schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mapRun } from "./map.ts";
import { buildProgram, leafCommands, runCli } from "./program.ts";

/**
 * The output contract (ADR 0015, issue #45): with --json every command prints one object on
 * stdout that fits the schema, when it works and when it fails. One case per command: a new
 * command without a case here fails the last test.
 */

const root = join(import.meta.dirname, "../../..");
const fixture = join(root, "fixtures/clients/plantpost");
const dir = mkdtempSync(join(tmpdir(), "mycel-cli-json-"));
const at = (...parts: string[]) => join(dir, ...parts);
const NOPE = at("nope", "missing.json");

/** Runs `mycel <args> --json` in-process and returns what a caller would get. */
async function json(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode = 0;
  // Nothing may reach stdout except through the command's own out(): one line, the object.
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await runCli(
      ["node", "mycel", "--runs-dir", at("runs"), ...args, "--json"],
      (s) => out.push(s),
      {
        err: (s) => err.push(s),
        setExitCode: (c) => {
          exitCode = c;
        },
      },
    );
    expect(stdout, `${args.join(" ")}: wrote to stdout directly`).not.toHaveBeenCalled();
  } finally {
    stdout.mockRestore();
  }
  expect(out, `${args.join(" ")}: stdout`).toHaveLength(1);
  const output = CliOutput.parse(JSON.parse(out[0] ?? ""));
  expect(output.exitCode).toBe(exitCode);
  return { output, err };
}

const cluster = (id: string, main: string, volume: number) => ({
  id,
  mainQuery: main,
  hub: main,
  queries: [main],
  sharedUrls: [],
  qdp: "page",
  outlier: false,
  label: "core",
  entity: "kamerplant",
  members: [
    { query: main, shared: 10, volume, scores: { relevance: 1, prominence: 0.5, popularity: 0.5 } },
  ],
  demand: { volume, gscImpressions: 0 },
  aiOverview: { present: false, cited: false },
  serpFeatures: [],
  qdpWhy: "Its own results page, so its own page.",
  outlierReasons: [],
});

const STATS = [
  ...["queries", "clustered", "clusters", "pages", "sections", "micro", "singletons"],
  ...["outliers", "ambiguousMembers", "borderlineMembers"],
];

beforeAll(async () => {
  // The same everywhere: no key from the machine the tests happen to run on.
  for (const key of ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD", "GSC_PROPERTY"]) {
    vi.stubEnv(key, "");
  }
  // A client folder halfway down the pipeline: a confirmed context, and the datasets that the
  // paid steps would have written.
  const context = {
    ...JSON.parse(readFileSync(join(fixture, "context.json"), "utf8")),
    confirmed: { by: "test", at: "2026-11-15T09:00:00.000Z" },
  };
  writeFileSync(at("context.json"), JSON.stringify(context));
  const query = (text: string, volume: number) => ({
    text,
    normalized: text,
    sources: ["dfs_related"],
    metrics: { volume },
  });
  writeFileSync(
    at("research.json"),
    JSON.stringify({
      site: context.site,
      market: context.market,
      seeds: [{ text: "kamerplant", normalized: "kamerplant", basis: "entity" }],
      queries: [query("kamerplant kopen", 900), query("tuinplant kopen", 400)],
      serps: [],
      competitors: [],
      pages: [],
      coverage: [],
      warnings: [],
    }),
  );
  const clusters = [
    cluster("grote", "grote kamerplant kopen", 1200),
    cluster("xxl", "xxl kamerplanten", 900),
    cluster("kopen", "kamerplanten kopen", 4000),
  ];
  writeFileSync(
    at("clusters.json"),
    JSON.stringify({
      site: context.site,
      market: context.market,
      minSharedUrls: 3,
      clusters,
      unclustered: [],
      stats: {
        ...Object.fromEntries(STATS.map((k) => [k, 0])),
        ...{ queries: 3, clustered: 3, clusters: 3, pages: 3, singletons: 3 },
      },
    }),
  );
  // A map with only its root: nothing in it can miss an eval target.
  mkdirSync(at("empty"));
  writeFileSync(at("empty", "context.json"), JSON.stringify(context));
  writeFileSync(
    at("empty", "clusters.json"),
    JSON.stringify({
      site: context.site,
      market: context.market,
      minSharedUrls: 3,
      clusters: [],
      unclustered: [],
      stats: Object.fromEntries(STATS.map((k) => [k, 0])),
    }),
  );
  const empty = await mapRun({
    runsDir: at("setup-runs"),
    clustersFile: at("empty", "clusters.json"),
    provider: "fake",
    model: "fake",
  });
  expect(empty.ok).toBe(true);
});
afterAll(() => vi.unstubAllEnvs());

interface Case {
  /** The command as typed after `mycel`. */
  name: string;
  /** Arguments of a call that works. Absent when working needs a person or a live key. */
  ok?: () => string[];
  /** Arguments of a call that fails, and the code it fails with. */
  fail: () => string[];
  code: string;
  exitCode: number;
}

/** Filled in by the writing run, read by the writing score. */
let writingRun = "";
const key = join(fixture, "business.key.json");
const proposed = at("business.proposed.json");

// In pipeline order: a case may read what an earlier one wrote.
const CASES: Case[] = [
  {
    name: "context propose",
    ok: () => [fixture, "--market", "NL / nl", "--provider", "fake", "--out", at("p", "c.json")],
    fail: () => [at("nope"), "--provider", "fake", "--out", at("p", "nope.json")],
    code: "INPUT_MISSING",
    exitCode: 3,
  },
  // Working means a person answering in the terminal: only its failure is covered here.
  { name: "context confirm", fail: () => [NOPE], code: "INPUT_MISSING", exitCode: 3 },
  {
    name: "research",
    // The run itself needs DataforSEO; the preview is the part that works without a key.
    ok: () => [at("context.json"), "--dry-run"],
    fail: () => [NOPE],
    code: "INPUT_MISSING",
    exitCode: 3,
  },
  {
    name: "business propose",
    ok: () => [at("context.json"), "--site", fixture, "--provider", "fake"],
    fail: () => [NOPE, "--site", fixture, "--provider", "fake"],
    code: "INPUT_MISSING",
    exitCode: 3,
  },
  {
    name: "business simulate",
    ok: () => [proposed, "--key", key],
    fail: () => [proposed, "--key", NOPE],
    code: "INPUT_MISSING",
    exitCode: 3,
  },
  {
    name: "business apply",
    ok: () => [proposed, "--answers", at("owner-answers.json")],
    fail: () => [proposed, "--answers", at("owner-answers.json"), "--by", "someone else"],
    code: "INPUT_INVALID",
    exitCode: 3,
  },
  {
    name: "business score",
    ok: () => [at("business.json"), "--key", key],
    fail: () => [at("context.json"), "--key", key],
    code: "INPUT_INVALID",
    exitCode: 3,
  },
  {
    name: "filter",
    ok: () => [at("research.json"), "--provider", "fake"],
    fail: () => [NOPE, "--provider", "fake"],
    code: "INPUT_MISSING",
    exitCode: 3,
  },
  {
    name: "cluster",
    ok: () => [at("queries.json"), "--dry-run"],
    fail: () => [at("queries.json"), "--budget", "abc"],
    code: "USAGE",
    exitCode: 2,
  },
  {
    name: "map",
    ok: () => [at("clusters.json"), "--provider", "fake"],
    // The run works, the map misses the client's gate: a failure that still has its outputs.
    fail: () => [
      at("clusters.json"),
      "--provider",
      "fake",
      "--expect",
      join(fixture, "expectations.json"),
    ],
    code: "BELOW_PASS_MARK",
    exitCode: 10,
  },
  { name: "status", ok: () => [dir], fail: () => [at("nope")], code: "INPUT_MISSING", exitCode: 3 },
  { name: "logs", ok: () => ["latest"], fail: () => ["nope"], code: "RUN_NOT_FOUND", exitCode: 3 },
  {
    name: "eval filter",
    ok: () => [fixture, "--provider", "fake", "--min-accuracy", "0"],
    fail: () => [fixture, "--provider", "fake"],
    code: "BELOW_PASS_MARK",
    exitCode: 10,
  },
  {
    name: "eval map",
    ok: () => [at("empty", "topical-map.json"), "--no-serps", "--review"],
    // The eval runs and writes its file; the map misses targets, so it is not a pass.
    fail: () => [at("topical-map.json"), "--no-serps"],
    code: "BELOW_PASS_MARK",
    exitCode: 10,
  },
  {
    name: "eval writing run",
    ok: () => [
      "--tasks",
      join(root, "evals/writing/sample.json"),
      "--models",
      "m-a",
      "--provider",
      "fake",
    ],
    fail: () => ["--tasks", NOPE, "--provider", "fake"],
    code: "INPUT_MISSING",
    exitCode: 3,
  },
  {
    name: "eval writing score",
    ok: () => [writingRun, "--candidate", "m-a"],
    fail: () => ["nope"],
    code: "RUN_NOT_FOUND",
    exitCode: 3,
  },
  // Working means a live Search Console key: only its failure is covered here.
  { name: "gsc check", fail: () => [], code: "KEY_MISSING", exitCode: 4 },
  {
    name: "llm ping",
    ok: () => ["--provider", "fake"],
    // A wrong flag never reaches the command: commander's own error, in the same shape.
    fail: () => ["--provider", "nope"],
    code: "USAGE",
    exitCode: 2,
  },
];

describe("mycel --json", () => {
  for (const c of CASES) {
    const words = c.name.split(" ");
    if (c.ok) {
      const args = c.ok;
      it(`${c.name}: one object that fits the contract when it works`, async () => {
        if (c.name === "eval writing score") {
          // The blind sheet, filled in the way a person would.
          const sheet = at("runs", writingRun, "writing-test", "scores.csv");
          const filled = readFileSync(sheet, "utf8")
            .trim()
            .split("\n")
            .map((l, i) => (i === 0 ? l : `${l.replace(/,+$/, "")},4,4,4,`));
          writeFileSync(sheet, `${filled.join("\n")}\n`);
        }
        const { output } = await json(...words, ...args());
        expect(output.error, JSON.stringify(output.error)).toBeUndefined();
        expect(output).toMatchObject({ status: "ok", command: c.name, exitCode: 0 });
        expect(output.version).toMatch(/^\d+\.\d+\.\d+(\+[0-9a-f]+)?$/);
        if (c.name === "eval writing run") writingRun = output.runId ?? "";
      });
    }
    it(`${c.name}: the error with its code when it fails`, async () => {
      const { output } = await json(...words, ...c.fail());
      expect(output).toMatchObject({
        status: "failed",
        command: c.name,
        exitCode: c.exitCode,
        error: { code: c.code },
        next: [],
      });
      expect(output.error?.message).not.toBe("");
      // No stack trace, no raw validator output: a sentence.
      expect(output.error?.message).not.toMatch(/\n\s+at |^\[\s*\{/);
    });
  }

  it("has a case for every command", () => {
    const names = leafCommands(buildProgram().commands).map((cmd) => {
      const path: string[] = [];
      for (let c: typeof cmd | null = cmd; c?.parent; c = c.parent) path.unshift(c.name());
      return path.join(" ");
    });
    expect(CASES.map((c) => c.name).sort()).toEqual([...names].sort());
    // Only these two can't work without a person or a live key.
    expect(CASES.filter((c) => !c.ok).map((c) => c.name)).toEqual(["context confirm", "gsc check"]);
    for (const cmd of leafCommands(buildProgram().commands)) {
      expect(
        cmd.options.map((o) => o.long),
        cmd.name(),
      ).toContain("--json");
    }
  });

  it("an eval below its targets fails with exit 10 and still says where its file is", async () => {
    const { output } = await json("eval", "map", at("topical-map.json"), "--no-serps");
    expect(output).toMatchObject({
      status: "failed",
      exitCode: 10,
      outputs: { eval: at("map-eval.json") },
      steps: [{ name: "map-eval", status: "ok" }],
      error: { code: "BELOW_PASS_MARK", transient: false },
    });
    const missed = (output.data as { missed: string[] }).missed;
    // Counted from the schema: a round that adds a target doesn't break this test.
    const targets = Object.values(MAP_TARGETS).filter(
      (t) => t.max !== undefined || t.min !== undefined,
    ).length;
    expect(missed.length).toBeGreaterThan(0);
    expect(output.error?.message).toBe(
      `the map misses ${missed.length} of ${targets} targets: ${missed.join(", ")}`,
    );
  });

  it("carries pointers and numbers, not the dataset", async () => {
    const filter = await json("filter", at("research.json"), "--provider", "fake");
    expect(filter.output.outputs).toEqual({ queries: at("queries.json") });
    expect(filter.output.runId).toMatch(/^\d{4}-/);
    expect(filter.output.steps).toMatchObject([{ name: "filter", status: "ok" }]);
    expect(filter.output.next[0]?.command).toBe(`mycel cluster ${at("queries.json")}`);
    expect(JSON.stringify(filter.output)).not.toContain("tuinplant");

    const dry = await json("cluster", at("queries.json"), "--dry-run");
    expect(dry.output.runId).toBeUndefined();
    expect(dry.output.data).toMatchObject({ plan: { total: 1, toBuy: 1, exact: true } });
    expect(dry.output.costUsd).toBe(0);
  });

  it("turns note lines into warnings, and a failed run keeps its run id, outputs and steps", async () => {
    const trial = at("trial");
    const proposal = join(trial, "context.json");
    await json(
      ...["context", "propose", fixture, "--market", "NL / nl", "--provider", "fake"],
      ...["--out", proposal],
    );
    writeFileSync(join(trial, "clusters.json"), readFileSync(at("clusters.json")));
    const map = await json(
      ...["map", join(trial, "clusters.json"), "--provider", "fake", "--allow-unconfirmed"],
      ...["--expect", join(fixture, "expectations.json")],
    );
    expect(map.output.warnings).toContain("context is not confirmed: trial run");
    expect(map.output.summary.some((l) => l.startsWith("note"))).toBe(false);
    expect(map.output).toMatchObject({
      status: "failed",
      exitCode: 10,
      outputs: { map: join(trial, "topical-map.json") },
      steps: [{ name: "map", status: "ok" }],
    });
    expect(map.output.runId).toMatch(/^\d{4}-/);
    expect(map.output.error?.fix).toContain("gate lines");
  });
});

describe("mycel --json, as a real process", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "apps/cli/src/index.ts", ...args], {
      cwd: root,
      encoding: "utf8",
    });

  it("keeps stdout to the one object: progress goes to stderr, a wrong flag exits 2", () => {
    const ping = run(
      "--runs-dir",
      at("process-runs"),
      "llm",
      "ping",
      "--provider",
      "fake",
      "--json",
    );
    expect(ping.status).toBe(0);
    expect(ping.stdout.trim().split("\n")).toHaveLength(1);
    expect(CliOutput.parse(JSON.parse(ping.stdout))).toMatchObject({
      status: "ok",
      command: "llm ping",
      steps: [{ name: "llm-ping", llmCalls: 1 }],
    });
    expect(ping.stderr).toContain("running     llm-ping");

    const wrong = run("cluster", "x.json", "--nope", "--json");
    expect(wrong.status).toBe(2);
    expect(CliOutput.parse(JSON.parse(wrong.stdout))).toMatchObject({
      status: "failed",
      command: "cluster",
      exitCode: 2,
      error: { code: "USAGE", message: "unknown option '--nope'" },
    });
  });

  it("says which code is running: --version names the commit", () => {
    const version = run("--version");
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+( \(commit [0-9a-f]{7,}\))?$/);
  });
});
