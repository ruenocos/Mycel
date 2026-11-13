import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
    expect(res.lines.join("\n")).toContain("GSC_PROPERTY is not set");
    expect(res.timeline).toContain("status failed");
  });
});
