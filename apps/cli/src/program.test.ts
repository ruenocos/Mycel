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
