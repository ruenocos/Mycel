import { describe, expect, it } from "vitest";
import { buildProgram } from "./program.ts";

describe("mycel cli", () => {
  it("is named mycel and has a version", () => {
    const program = buildProgram();
    expect(program.name()).toBe("mycel");
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
