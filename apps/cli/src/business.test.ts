import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusinessProfile } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import {
  businessApply,
  businessPropose,
  businessScore,
  businessSimulate,
  readContextWithBusiness,
} from "./business.ts";

const fixture = join(import.meta.dirname, "../../../fixtures/clients/praktijk-beweegruimte");

describe("mycel business", () => {
  it("proposes from a fixture, plays the owner from the key, confirms and scores", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mycel-cli-business-"));
    copyFileSync(join(fixture, "context.json"), join(dir, "context.json"));
    const res = await businessPropose({
      runsDir: join(dir, "runs"),
      contextFile: join(dir, "context.json"),
      site: fixture,
      provider: "fake",
      model: "fake",
    });
    expect(res.ok).toBe(true);
    expect(res.lines.join("\n")).toContain("no research.json");
    const proposed = BusinessProfile.parse(JSON.parse(readFileSync(res.out as string, "utf8")));
    // The fake proposes one offering per service page, each proven by that page.
    expect(proposed.offerings.length).toBe(6);
    expect(proposed.offerings.every((o) => o.sources[0]?.from === "site")).toBe(true);

    const key = join(fixture, "business.key.json");
    const before = businessScore({ profileFile: res.out as string, keyFile: key, language: "nl" });
    expect(before.score.notOffered.recall).toBe(0);

    const sim = businessSimulate({ proposedFile: res.out as string, keyFile: key, language: "nl" });
    const applied = businessApply({ proposedFile: res.out as string, answersFile: sim.out });
    expect(applied.lines[0]).toContain("confirmed   by simulated owner");
    const after = businessScore({ profileFile: applied.out, keyFile: key, language: "nl" });
    expect(after.score.offerings.recall).toBe(1);
    expect(after.score.notOffered.recall).toBe(1);

    // The map eval and later steps see the confirmed profile next to the context.
    expect(readContextWithBusiness(join(dir, "context.json")).business?.confirmed).toBeDefined();
  });

  it("refuses answers signed by someone else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mycel-cli-business-"));
    copyFileSync(join(fixture, "context.json"), join(dir, "context.json"));
    const res = await businessPropose({
      runsDir: join(dir, "runs"),
      contextFile: join(dir, "context.json"),
      site: fixture,
      provider: "fake",
      model: "fake",
    });
    const sim = businessSimulate({
      proposedFile: res.out as string,
      keyFile: join(fixture, "business.key.json"),
      language: "nl",
    });
    expect(() =>
      businessApply({ proposedFile: res.out as string, answersFile: sim.out, by: "Wons" }),
    ).toThrow(/doesn't match/);
  });
});
