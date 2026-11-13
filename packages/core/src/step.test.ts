import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { RunStore } from "./log/run-store.ts";
import { defineStep, runStep, StepValidationError } from "./step.ts";

let runsDir: string;
const newRun = () =>
  RunStore.create({ runsDir, client: "test", command: "test", cliVersion: "0.0.0" });

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "mycel-step-"));
});

const double = defineStep({
  name: "double",
  version: "1",
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number().int() }),
  run: async ({ n }) => ({ n: n * 2 }),
});

describe("runStep", () => {
  it("validates, runs and saves input and output", async () => {
    const run = newRun();
    await expect(runStep(run, double, { n: 2 })).resolves.toEqual({ n: 4 });
    const dir = join(run.dir, "double");
    expect(JSON.parse(readFileSync(join(dir, "input.json"), "utf8"))).toEqual({ n: 2 });
    expect(JSON.parse(readFileSync(join(dir, "output.json"), "utf8"))).toMatchObject({
      stepVersion: "1",
      output: { n: 4 },
    });
  });

  it("rejects invalid input before running", async () => {
    const run = newRun();
    await expect(runStep(run, double, { n: "two" } as never)).rejects.toBeInstanceOf(
      StepValidationError,
    );
    expect(run.summary.steps[0]?.status).toBe("failed");
  });

  it("retries invalid output, then stops the run (never passes it on)", async () => {
    let calls = 0;
    const flaky = defineStep({
      ...double,
      name: "flaky",
      maxAttempts: 3,
      run: async ({ n }, { attempt }) => {
        calls++;
        return attempt < 3 ? ({ n: n + 0.5 } as never) : { n };
      },
    });
    const run = newRun();
    await expect(runStep(run, flaky, { n: 1 })).resolves.toEqual({ n: 1 });
    expect(calls).toBe(3);
    expect(existsSync(join(run.dir, "flaky", "invalid-output-1.json"))).toBe(true);

    const broken = defineStep({ ...flaky, name: "broken", run: async () => ({ n: 0.5 }) as never });
    await expect(runStep(run, broken, { n: 1 })).rejects.toThrow(/output failed validation/);
  });

  it("reuses a saved output from a previous run when the version matches", async () => {
    const first = newRun();
    await runStep(first, double, { n: 5 });

    let ran = false;
    const spy = defineStep({
      ...double,
      run: async () => {
        ran = true;
        return { n: 0 };
      },
    });
    const second = newRun();
    await expect(runStep(second, spy, { n: 5 }, { resumeFromDir: first.dir })).resolves.toEqual({
      n: 10,
    });
    expect(ran).toBe(false);

    const bumped = defineStep({ ...spy, version: "2" });
    const third = newRun();
    await runStep(third, bumped, { n: 5 }, { resumeFromDir: first.dir });
    expect(ran).toBe(true);
  });
});
