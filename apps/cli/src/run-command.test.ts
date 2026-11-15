import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BudgetExceededError,
  DataforseoError,
  GscError,
  LiveCallBlockedError,
  LlmProviderError,
  WordPressError,
} from "@mycel/connectors";
import { ERROR_CODES, MycelError, RunStore } from "@mycel/core";
import { ClusterSet } from "@mycel/schema";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { describeError, EXIT_CODES } from "./errors.ts";
import { command, readInput } from "./input.ts";
import { buildProgram } from "./program.ts";
import { type CommandIo, formatError, runCommand } from "./run-command.ts";

const root = join(import.meta.dirname, "../../..");
const fixture = (name: string) => join(root, "fixtures/clients", name);
const tmp = () => mkdtempSync(join(tmpdir(), "mycel-cli-run-"));

/** Captures what a command prints and the exit code it sets. */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const state = { exitCode: 0 };
  const io: CommandIo = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    setExitCode: (c) => {
      state.exitCode = c;
    },
  };
  return { io, out, err, state, text: () => out.join("\n"), errors: () => err.join("\n") };
}

async function mycel(...args: string[]) {
  const c = capture();
  await buildProgram(c.io.out, c.io).parseAsync(["node", "mycel", ...args]);
  return c;
}

describe("describeError", () => {
  it("gives every error code an exit code, and only success gets 0", () => {
    for (const code of ERROR_CODES) expect(EXIT_CODES[code]).toBeGreaterThan(0);
  });

  it("reads what the connectors already know: refused, temporary, budget, paid calls off", () => {
    const cases: [unknown, string, number, boolean][] = [
      [new DataforseoError("HTTP 503", "serp", 503, true), "TEMPORARY", 75, true],
      [new DataforseoError("HTTP 401", "serp", 401, false), "AUTH_REFUSED", 4, false],
      [new GscError("network error: reset", "sites", 0, true), "TEMPORARY", 75, true],
      [new LlmProviderError("HTTP 429: slow down", "ollama", 429, true), "TEMPORARY", 75, true],
      [new LlmProviderError("HTTP 400: bad model", "ollama", 400, false), "RUN_FAILED", 1, false],
      [new WordPressError("GET https://x failed: timeout", "error"), "TEMPORARY", 75, true],
      [new BudgetExceededError("run budget of $1 reached"), "BUDGET_EXCEEDED", 11, false],
      [new LiveCallBlockedError("SERP is not cached"), "PAID_CALLS_OFF", 11, false],
      [new MycelError("NOT_CONFIRMED", "x isn't confirmed yet"), "NOT_CONFIRMED", 3, false],
      [new MycelError("WOULD_REPLACE", "x was confirmed"), "WOULD_REPLACE", 5, false],
      [new Error("something else"), "UNEXPECTED", 1, false],
    ];
    for (const [err, code, exit, transient] of cases) {
      const info = describeError(err);
      expect(info).toMatchObject({ code, transient });
      expect(EXIT_CODES[info.code]).toBe(exit);
    }
    expect(describeError(new BudgetExceededError("x")).fix).toContain("--budget");
    expect(describeError(new LiveCallBlockedError("x")).fix).toContain("--live-serp");
  });
});

describe("readInput", () => {
  it("names a missing file and the command that writes it", () => {
    const read = () =>
      readInput("/nope/clusters.json", ClusterSet, {
        name: "clusters file",
        writtenBy: "mycel cluster",
      });
    expect(read).toThrow("no clusters file at /nope/clusters.json");
    try {
      read();
    } catch (err) {
      expect(describeError(err)).toMatchObject({
        code: "INPUT_MISSING",
        fix: "run mycel cluster first, or pass the path of the file it wrote",
      });
    }
  });

  it("says in one line why a file is the wrong kind, instead of the validator's raw output", () => {
    const kind = { name: "clusters file", writtenBy: "mycel cluster" };
    const pages = join(fixture("plantpost"), "pages.json");
    try {
      readInput(pages, ClusterSet, kind);
      expect.unreachable();
    } catch (err) {
      const info = describeError(err);
      expect(info.code).toBe("INPUT_INVALID");
      expect(info.message).toContain("pages.json is not a clusters file (");
      expect(info.message).toContain("missing market");
      expect(info.message).not.toContain("{");
      expect(info.message.split("\n")).toHaveLength(1);
    }
    const broken = join(tmp(), "broken.json");
    writeFileSync(broken, "{ not json");
    expect(() => readInput(broken, ClusterSet, kind)).toThrow("is not valid JSON");
  });

  it("quotes a path with spaces so the next command can be pasted", () => {
    expect(command("map", "C:\\Personal Work\\clusters.json")).toBe(
      'mycel map "C:\\Personal Work\\clusters.json"',
    );
    expect(command("map", "clients/x/clusters.json")).toBe("mycel map clients/x/clusters.json");
  });
});

describe("runCommand", () => {
  it("prints the result, a short run summary, the files and the next step", async () => {
    const runsDir = tmp();
    const c = capture();
    await runCommand(c.io, { runsDir }, async () => {
      const run = RunStore.create({ runsDir, client: "x", command: "cluster", cliVersion: "0" });
      await run.step("cluster", async (ctx) => {
        for (let i = 0; i < 300; i++) {
          ctx.recordApiCall({
            service: "dataforseo",
            endpoint: "serp",
            requestHash: `h${i}`,
            cache: i < 290 ? "hit" : "miss",
            costUsd: i < 290 ? 0 : 0.0006,
            latencyMs: 1,
            status: 200,
            startedAt: new Date().toISOString(),
          });
        }
      });
      run.finish();
      return {
        ok: true,
        runId: run.runId,
        lines: ["clusters    12: 9 pages, 2 sections, 1 micro"],
        outputs: { clusters: "clients/x/clusters.json" },
        next: [{ command: "mycel map clients/x/clusters.json" }],
      };
    });
    // 300 API calls are one line, not 300: the full timeline is in `mycel logs`.
    expect(c.out.length).toBeLessThan(10);
    expect(c.text()).toMatch(/steps {7}cluster .*\$0\.0060 {2}300 API calls \(290 from cache\)/);
    expect(c.text()).toContain("(full log: mycel logs ");
    expect(c.text()).toContain("wrote       clients/x/clusters.json  (clusters)");
    expect(c.out.at(-1)).toBe("next        mycel map clients/x/clusters.json");
    expect(c.err).toEqual([]);
    expect(c.state.exitCode).toBe(0);
  });

  it("on a failed run: error, fix, code and the log command on stderr, and no next step", async () => {
    const runsDir = tmp();
    const c = capture();
    await runCommand(c.io, { runsDir }, async () => {
      const run = RunStore.create({ runsDir, client: "x", command: "cluster", cliVersion: "0" });
      const failure = new BudgetExceededError("DataforSEO run budget of $1 reached");
      await run
        .step("cluster", async () => {
          throw failure;
        })
        .catch(() => undefined);
      run.finish(failure);
      return { ok: false, runId: run.runId, lines: [], failure, next: [{ command: "never" }] };
    });
    expect(c.text()).toContain("FAILED");
    expect(c.text()).not.toContain("never");
    expect(c.err[0]).toBe("error       DataforSEO run budget of $1 reached");
    expect(c.err[1]).toMatch(/^fix {9}raise --budget/);
    expect(c.err[2]).toBe("code        BUDGET_EXCEEDED (a retry will not help)");
    expect(c.err[3]).toMatch(/^log {9}mycel logs \S+ --level debug$/);
    expect(c.state.exitCode).toBe(11);
  });

  it("keeps a long message readable under its label", () => {
    const lines = formatError({ code: "RUN_FAILED", message: "one\ntwo", transient: true });
    expect(lines).toEqual([
      "error       one\n            two",
      "code        RUN_FAILED (a retry can help)",
    ]);
  });
});

describe("mycel, end to end in-process", () => {
  it("never prints a stack trace for an unknown run", async () => {
    const c = await mycel("--runs-dir", tmp(), "logs", "nope");
    expect(c.out).toEqual([]);
    expect(c.errors()).toContain('error       no run matches "nope"');
    expect(c.errors()).toContain("fix         mycel logs lists the recent runs");
    expect(c.errors()).not.toMatch(/\n\s+at /);
    expect(c.state.exitCode).toBe(3);
  });

  it("explains a wrong input file in one line (exit 3) and a bad budget as usage (exit 2)", async () => {
    const wrong = await mycel("map", join(fixture("plantpost"), "pages.json"));
    expect(wrong.errors()).toContain("pages.json is not a clusters file (missing ");
    expect(wrong.errors()).toContain("fix         pass the file that mycel cluster wrote");
    expect(wrong.err.length).toBeLessThan(5);
    expect(wrong.state.exitCode).toBe(3);

    const dir = tmp();
    const ctx = join(dir, "context.json");
    writeFileSync(ctx, "{}");
    const budget = await mycel("research", ctx, "--budget", "abc");
    expect(budget.errors()).toContain("--budget must be a positive number");
    expect(budget.state.exitCode).toBe(2);
  });

  it("ends a fixture run in a short screen with the next command", async () => {
    const dir = tmp();
    const out = join(dir, "context.json");
    const c = await mycel(
      ...["--runs-dir", join(dir, "runs"), "context", "propose", fixture("plantpost")],
      ...["--market", "NL / nl", "--provider", "fake", "--out", out],
    );
    expect(c.state.exitCode).toBe(0);
    expect(c.err).toEqual([]);
    expect(c.out.length).toBeLessThan(25);
    expect(c.text()).toMatch(/steps {7}context-sources/);
    expect(c.text()).toContain("1 model call");
    expect(c.text()).toContain(`wrote       ${out}  (proposal)`);
    expect(c.out.at(-1)).toBe(`next        mycel context confirm ${out}`);
  });

  it("tells an eval below its pass mark (exit 10) apart from a crash", async () => {
    const c = await mycel(
      ...["--runs-dir", tmp(), "eval", "filter", fixture("plantpost")],
      ...["--provider", "fake"],
    );
    expect(c.text()).toContain("FAIL  accuracy");
    expect(c.errors()).toContain("code        BELOW_PASS_MARK (a retry will not help)");
    expect(c.state.exitCode).toBe(10);
  });

  it("shows the route and the exit codes in the help, and examples per command", () => {
    const program = buildProgram();
    let help = "";
    program.configureOutput({ writeOut: (s) => (help += s) });
    program.outputHelp();
    expect(help).toContain("A typical run, in order");
    const order = ["context propose", "context confirm", "research", "filter", "cluster", "map"];
    const at = order.map((name) => help.indexOf(`mycel ${name} `));
    expect(at.every((n) => n > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(help).toMatch(/75 {2}temporary/);
    // The command list follows the pipeline too.
    const listed = program.commands.map((c) => c.name());
    const pipeline = ["context", "research", "filter", "cluster", "map"];
    // Other commands may sit in between (a new step), as long as these keep their order.
    expect(listed.filter((name) => pipeline.includes(name))).toEqual(pipeline);
    expect(listed.indexOf("map")).toBeLessThan(listed.indexOf("logs"));
    expect(help).toContain("mycel llm ping");
    expect(help).toContain("DATAFORSEO_LOGIN");
    // Every command that can fail takes --debug.
    const leaves = (cmds: readonly Command[]): Command[] =>
      cmds.flatMap((c) => (c.commands.length > 0 ? leaves(c.commands) : [c]));
    for (const cmd of leaves(program.commands)) {
      expect(
        cmd.options.map((o) => o.long),
        cmd.name(),
      ).toContain("--debug");
    }
    for (const name of ["research", "filter", "cluster", "map", "logs"]) {
      let text = "";
      const cmd = program.commands.find((c) => c.name() === name);
      cmd?.configureOutput({ writeOut: (s) => (text += s) });
      cmd?.outputHelp();
      expect(text).toContain("Examples:");
    }
  });
});

describe("mycel, as a real process", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "apps/cli/src/index.ts", ...args], {
      cwd: root,
      encoding: "utf8",
    });

  it("exits 2 on a wrong flag, 0 on --help, and 3 without a stack trace on a missing file", () => {
    const flag = run("map", "x.json", "--nope");
    expect(flag.status).toBe(2);
    expect(flag.stderr).toContain("error       unknown option '--nope'");
    expect(flag.stderr).toContain("fix         mycel --help");
    expect(flag.stdout).toBe("");

    const help = run("--help");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Exit codes:");

    const missing = run("map", "/nope/clusters.json");
    expect(missing.status).toBe(3);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("error       no clusters file at /nope/clusters.json");
    expect(missing.stderr).not.toMatch(/\n\s+at /);
  }, 30_000);
});
