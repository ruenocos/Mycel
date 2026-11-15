import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunMeta } from "@mycel/core";
import { describe, expect, it } from "vitest";
import { describeError } from "./errors.ts";
import { buildProgram } from "./program.ts";

describe("mycel cli", () => {
  it("is named mycel and has a version", () => {
    const program = buildProgram();
    expect(program.name()).toBe("mycel");
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("mycel logs", () => {
  it("says so when there are no runs", async () => {
    const lines: string[] = [];
    await buildProgram((s) => lines.push(s)).parseAsync([
      "node",
      "mycel",
      "--runs-dir",
      "/nonexistent-mycel-runs",
      "logs",
    ]);
    expect(lines).toEqual(["No runs in /nonexistent-mycel-runs."]);
  });
});

describe("mycel llm ping", () => {
  it("makes one logged call that shows up in mycel logs", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "mycel-cli-"));
    const lines: string[] = [];
    await buildProgram((s) => lines.push(s)).parseAsync([
      "node",
      "mycel",
      "--runs-dir",
      runsDir,
      "llm",
      "ping",
      "--provider",
      "fake",
    ]);
    const timeline = lines.join("\n");
    expect(timeline).toContain("status ok");
    expect(timeline).toContain("llm  fake deepseek-v4.1-flash@fake:0000000");
    expect(timeline).toContain("llm-ping@1");
    expect(timeline).toMatch(/→ llm-ping\/llm\/llm-0001\.json/);
  });
});

describe("mycel gsc check", () => {
  it("explains what is missing when GSC is not configured", async () => {
    const { gscCheck } = await import("./gsc-check.ts");
    const runsDir = mkdtempSync(join(tmpdir(), "mycel-cli-"));
    const res = await gscCheck({ runsDir, env: {} });
    expect(res.ok).toBe(false);
    expect(describeError(res.failure)).toMatchObject({ code: "KEY_MISSING" });
    expect(describeError(res.failure).message).toContain("GSC_PROPERTY is not set");
    expect(readRunMeta(runsDir, res.runId).status).toBe("failed");
  });
});

describe("mycel eval writing", () => {
  it("runs the sample set on the fake provider, writes a blind sheet and scores it", async () => {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const runsDir = mkdtempSync(join(tmpdir(), "mycel-cli-"));
    const lines: string[] = [];
    await buildProgram((s) => lines.push(s)).parseAsync([
      "node",
      "mycel",
      "--runs-dir",
      runsDir,
      "eval",
      "writing",
      "run",
      "--tasks",
      "evals/writing/sample.json",
      "--models",
      "m-a,m-b:7b",
      "--provider",
      "fake",
    ]);
    const out = lines.join("\n");
    expect(out).toContain("answers   8 ok, 0 failed");
    expect(out).toContain("write-m-b-7b");
    const runId = /scores\s+.*mycel eval writing score (\S+)\)/.exec(out)?.[1] ?? "";
    const dir = join(runsDir, runId, "writing-test");
    const sheet = readFileSync(join(dir, "sheet.md"), "utf8");
    expect(sheet).not.toMatch(/m-a|m-b/);

    const csv = readFileSync(join(dir, "scores.csv"), "utf8")
      .trim()
      .split("\n")
      .map((l, i) => (i === 0 ? l : `${l.replace(/,+$/, "")},4,4,4,`))
      .join("\n");
    writeFileSync(join(dir, "scores.csv"), `${csv}\n`);
    const scored: string[] = [];
    await buildProgram((s) => scored.push(s)).parseAsync([
      "node",
      "mycel",
      "--runs-dir",
      runsDir,
      "eval",
      "writing",
      "score",
      "latest",
      "--candidate",
      "m-a",
    ]);
    expect(scored.join("\n")).toContain(
      "m-a is 0 behind the best and invented no facts: it writes.",
    );
  });
});
