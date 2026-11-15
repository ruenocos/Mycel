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
import { describeError } from "./errors.ts";
import { runCli } from "./program.ts";

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

  it("ends like every other command: files, next step, and errors with a fix and a code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mycel-cli-business-"));
    copyFileSync(join(fixture, "context.json"), join(dir, "context.json"));
    const mycel = async (...args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      let exitCode = 0;
      await runCli(
        ["node", "mycel", "--runs-dir", join(dir, "runs"), ...args],
        (s) => out.push(s),
        {
          err: (s) => err.push(s),
          setExitCode: (c) => {
            exitCode = c;
          },
        },
      );
      return { out, text: out.join("\n"), errors: err.join("\n"), exitCode };
    };
    const proposed = join(dir, "business.proposed.json");
    const answers = join(dir, "owner-answers.json");
    const key = join(fixture, "business.key.json");

    const propose = await mycel(
      ...["business", "propose", join(dir, "context.json")],
      ...["--site", fixture, "--provider", "fake"],
    );
    expect(propose.exitCode).toBe(0);
    expect(propose.text).toMatch(/steps {7}business-sources/);
    expect(propose.text).toContain(`wrote       ${proposed}  (proposal)`);
    expect(propose.text).toContain(
      `next        mycel business apply ${proposed} --answers ${answers}`,
    );
    // The old ending is gone: no second copy of the timeline, no "failed" line on stdout.
    expect(propose.text).not.toContain("▶ run start");

    const simulate = await mycel("business", "simulate", proposed, "--key", key);
    expect(simulate.out.at(-1)).toBe(
      `next        mycel business apply ${proposed} --answers ${answers}`,
    );

    const wrongName = await mycel(
      ...["business", "apply", proposed, "--answers", answers, "--by", "Wons"],
    );
    expect(wrongName.exitCode).toBe(3);
    expect(wrongName.out).toEqual([]);
    expect(wrongName.errors).toContain('error       --by "Wons" doesn\'t match the answers file');
    expect(wrongName.errors).toContain("code        INPUT_INVALID (a retry will not help)");

    const apply = await mycel("business", "apply", proposed, "--answers", answers);
    expect(apply.exitCode).toBe(0);
    expect(apply.text).toContain(`wrote       ${join(dir, "business.json")}  (profile)`);

    const missing = await mycel("business", "score", join(dir, "nope.json"), "--key", key);
    expect(missing.exitCode).toBe(3);
    expect(missing.errors).toContain(
      `error       no business profile at ${join(dir, "nope.json")}`,
    );
    expect(missing.errors).toContain("fix         run mycel business propose first");

    // A file of the wrong kind is one sentence, not the validator's output.
    try {
      businessScore({ profileFile: join(dir, "context.json"), keyFile: key, language: "nl" });
      expect.unreachable();
    } catch (err) {
      const info = describeError(err);
      expect(info.code).toBe("INPUT_INVALID");
      expect(info.message).toContain("context.json is not a business profile (");
      expect(info.message.split("\n")).toHaveLength(1);
    }
  });
});
