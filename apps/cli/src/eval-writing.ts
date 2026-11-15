import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeProvider, LlmClient, type LlmProvider, OllamaProvider } from "@mycel/connectors";
import {
  autoCheck,
  blindSheet,
  buildWritingMessages,
  CORE_VERSION,
  MycelError,
  parseScores,
  parseWriter,
  RunStore,
  resolveRunId,
  verdict,
  WRITING_TEMPLATE,
  WRITING_TEMPLATE_EN,
  type WritingVerdict,
} from "@mycel/core";
import { WritingKey, type WritingOutput, WritingTestSet } from "@mycel/schema";
import { command, readInput } from "./input.ts";
import type { CommandResult } from "./run-command.ts";

const OUT = "writing-test";
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function providers(env: NodeJS.ProcessEnv): LlmProvider[] {
  const fake = new FakeProvider([], (req) => {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";
    return `Antwoord: ${user.split("\n")[0]?.slice(0, 60)} [s1]`;
  });
  const ollama = new OllamaProvider({
    host: env.OLLAMA_HOST ?? "https://ollama.com",
    ...(env.OLLAMA_API_KEY ? { apiKey: env.OLLAMA_API_KEY } : {}),
    timeoutMs: 300_000,
  });
  return [fake, ollama];
}

export interface WritingRunOptions {
  runsDir: string;
  tasksPath: string;
  models: string[];
  provider: string;
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Every model writes every task inside one logged run; then the blind sheet is written next to it. */
export async function writingRun(
  opts: WritingRunOptions,
): Promise<CommandResult & { runId: string; dir: string }> {
  const env = opts.env ?? process.env;
  const set = readInput(opts.tasksPath, WritingTestSet, {
    name: "writing task set",
    writtenBy: "hand (see evals/writing/sample.json)",
  });
  const run = RunStore.create({
    runsDir: opts.runsDir,
    client: "none",
    command: "eval writing run",
    cliVersion: CORE_VERSION,
    config: { tasks: opts.tasksPath, set: `${set.name}@${set.version}`, models: opts.models },
    ...(opts.debug ? { consoleLevel: "debug" as const } : {}),
  });
  const list = providers(env);
  const provider = list.find((p) => p.name === opts.provider);
  const llm = new LlmClient({ providers: list, defaultProvider: opts.provider });
  const outputs: WritingOutput[] = [];
  const models: { model: string; digest?: string }[] = [];
  let failure: unknown;
  try {
    for (const entry of opts.models) {
      // A writer is a model, or a model with English instructions (`model+en`, ADR 0013).
      // The label goes on the blind sheet; the real model name goes to the provider and the log.
      const writer = parseWriter(entry);
      const model = writer.label;
      const digest = await provider?.modelDigest?.(writer.model).catch((err: unknown) => {
        run.log.warn("model digest lookup failed", {
          model: writer.model,
          error: (err as Error).message,
        });
        return undefined;
      });
      models.push({ model, ...(digest ? { digest } : {}) });
      await run.step(`write-${slug(model)}`, async (ctx) => {
        for (const task of set.tasks) {
          try {
            const res = await llm.generate(
              {
                model: writer.model,
                template: writer.instructions === "en" ? WRITING_TEMPLATE_EN : WRITING_TEMPLATE,
                params: { temperature: 0.5, seed: 42 },
                messages: buildWritingMessages(set, task, writer.instructions),
              },
              ctx,
            );
            outputs.push({
              taskId: task.id,
              model,
              ...(digest ? { modelDigest: digest } : {}),
              text: res.content,
            });
          } catch (err) {
            // The failed call is already recorded by LlmClient; keep going so one bad task
            // doesn't sink the whole test, and show it on the sheet.
            ctx.log.warn("writing task failed", {
              model,
              task: task.id,
              error: (err as Error).message,
            });
            outputs.push({ taskId: task.id, model, text: "", error: (err as Error).message });
          }
        }
      });
    }
  } catch (err) {
    failure = err;
  }
  const dir = join(opts.runsDir, run.runId, OUT);
  mkdirSync(dir, { recursive: true });
  const sheet = blindSheet(set, outputs, run.runId, models);
  const checks = outputs.map((o) => {
    const task = set.tasks.find((t) => t.id === o.taskId);
    return { taskId: o.taskId, model: o.model, ...(task ? autoCheck(task, o.text) : {}) };
  });
  writeFileSync(join(dir, "tasks.json"), JSON.stringify(set, null, 2));
  writeFileSync(join(dir, "outputs.json"), JSON.stringify(outputs, null, 2));
  writeFileSync(join(dir, "auto-check.json"), JSON.stringify(checks, null, 2));
  writeFileSync(join(dir, "key.json"), JSON.stringify(sheet.key, null, 2));
  writeFileSync(join(dir, "sheet.md"), sheet.markdown);
  writeFileSync(join(dir, "scores.csv"), sheet.csv);
  run.finish(failure);
  const failed = outputs.filter((o) => o.error).length;
  return {
    runId: run.runId,
    ok: failure === undefined,
    dir,
    lines: [
      `answers   ${outputs.length - failed} ok, ${failed} failed`,
      `models    ${models.map((m) => `${m.model}@${m.digest ?? "?"}`).join(", ")}`,
      `sheet     ${join(dir, "sheet.md")}`,
      `scores    ${join(dir, "scores.csv")}  (fill in, then: mycel eval writing score ${run.runId})`,
    ],
    ...(failure !== undefined ? { failure } : {}),
  };
}

/** Unblind the filled-in scores and apply the decision rule. */
export function writingScore(opts: { runsDir: string; run: string; candidate: string }): {
  verdict: WritingVerdict;
  lines: string[];
} {
  const runId = resolveRunId(opts.runsDir, opts.run);
  const dir = join(opts.runsDir, runId, OUT);
  if (!existsSync(join(dir, "key.json"))) {
    throw new MycelError("INPUT_MISSING", `no writing test in run ${runId}`, {
      fix: `pass a run made by ${command("eval writing run")}`,
    });
  }
  const set = WritingTestSet.parse(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")));
  const key = WritingKey.parse(JSON.parse(readFileSync(join(dir, "key.json"), "utf8")));
  const scores = parseScores(readFileSync(join(dir, "scores.csv"), "utf8"));
  const v = verdict(set, key, scores, opts.candidate);
  writeFileSync(join(dir, "verdict.json"), JSON.stringify(v, null, 2));
  const lines = ["model                      natural correct tone  overall invented"];
  for (const r of v.results) {
    lines.push(
      `${`${r.model}@${r.digest ?? "?"}`.padEnd(26)} ${r.natural.toFixed(2).padStart(7)} ${r.correct.toFixed(2).padStart(7)} ${r.tone.toFixed(2).padStart(5)} ${r.overall.toFixed(2).padStart(8)} ${String(r.inventedFacts).padStart(8)}`,
    );
  }
  lines.push("", v.reason, `written to ${join(dir, "verdict.json")}`);
  return { verdict: v, lines };
}
