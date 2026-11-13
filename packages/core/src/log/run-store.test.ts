import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { memorySink } from "./logger.ts";
import { REDACTED, redact } from "./redact.ts";
import { RunStore } from "./run-store.ts";
import { formatTimeline, listRuns, readRunMeta, resolveRunId } from "./timeline.ts";

const SECRET = "sk-test-supersecret-123456";

let runsDir: string;
beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "mycel-runs-"));
});

async function dummyRun() {
  const sink = memorySink();
  const run = RunStore.create({
    runsDir,
    client: "plantpost",
    command: "map",
    cliVersion: "0.0.0",
    config: { apiKey: SECRET, budgetUsd: 6 },
    secrets: [SECRET],
    sink,
  });

  await run.step("context", async (ctx) => {
    ctx.log.info("pages read", { count: 3 });
    ctx.recordApiCall({
      service: "dataforseo",
      endpoint: "serp/google/organic/live/advanced",
      requestHash: "abc123",
      cache: "miss",
      costUsd: 0.002,
      latencyMs: 812,
      status: 200,
      startedAt: new Date().toISOString(),
    });
    ctx.recordLlmCall({
      provider: "ollama",
      endpoint: "https://ollama.com/api/chat",
      model: "deepseek-v4.1-flash",
      modelDigest: "sha256:0123456789abcdef",
      params: { temperature: 0.2, seed: 42, format: "json" },
      promptTemplate: { id: "context-proposal", version: "1" },
      promptHash: "ph-1",
      request: { messages: [{ role: "user", content: `key is ${SECRET}` }] },
      response: { message: { content: '{"ok":true}' }, done_reason: "stop" },
      usage: { inputTokens: 1200, outputTokens: 300 },
      providerTimings: { total_duration: 850_000_000, eval_count: 300, done_reason: "stop" },
      costUsd: 0.0004,
      latencyMs: 850,
      attempt: 1,
      status: "ok",
      startedAt: new Date().toISOString(),
    });
  });

  await expect(
    run.step("cluster", async (ctx) => {
      ctx.log.info("clustering");
      throw new Error("SERP overlap failed", { cause: new Error("empty SERP") });
    }),
  ).rejects.toThrow("SERP overlap failed");

  const meta = run.finish();
  return { run, meta, sink };
}

describe("RunStore", () => {
  it("writes run.json with per-step status and summed cost", async () => {
    const { run, meta } = await dummyRun();
    expect(meta.status).toBe("failed");
    expect(meta.costUsd).toBeCloseTo(0.0024, 6);
    expect(meta.steps.map((s) => [s.name, s.status])).toEqual([
      ["context", "ok"],
      ["cluster", "failed"],
    ]);
    const onDisk = readRunMeta(runsDir, run.runId);
    expect(onDisk.steps[1]?.error?.message).toBe("SERP overlap failed");
    expect(onDisk.steps[1]?.error?.cause?.message).toBe("empty SERP");
    expect(onDisk.steps[0]).toMatchObject({ llmCalls: 1, apiCalls: 1 });
  });

  it("saves the full LLM call and API call records per step", async () => {
    const { run } = await dummyRun();
    const llmDir = join(runsDir, run.runId, "context", "llm");
    const [file] = readdirSync(llmDir);
    expect(file).toBe("llm-0002.json");
    const rec = JSON.parse(readFileSync(join(llmDir, file ?? ""), "utf8"));
    expect(rec).toMatchObject({
      model: "deepseek-v4.1-flash",
      modelDigest: "sha256:0123456789abcdef",
      params: { temperature: 0.2, seed: 42 },
      providerTimings: { eval_count: 300 },
      response: { done_reason: "stop" },
    });
    expect(existsSync(join(runsDir, run.runId, "context", "api.jsonl"))).toBe(true);
  });

  it("never writes secrets to disk", async () => {
    const { run } = await dummyRun();
    const dir = join(runsDir, run.runId);
    const files = [
      "run.json",
      "log.jsonl",
      "context/api.jsonl",
      join("context", "llm", "llm-0002.json"),
    ];
    for (const f of files) expect(readFileSync(join(dir, f), "utf8")).not.toContain(SECRET);
    expect(readRunMeta(runsDir, run.runId).config.apiKey).toBe(REDACTED);
  });

  it("logs every line with runId and step", async () => {
    const { run, sink } = await dummyRun();
    expect(sink.lines.every((l) => l.runId === run.runId)).toBe(true);
    const failed = sink.lines.find((l) => l.event === "step.failed");
    expect(failed).toMatchObject({ step: "cluster", level: "error" });
    expect(failed?.err?.message).toBe("SERP overlap failed");
  });
});

describe("timeline", () => {
  it("shows steps, calls and the failure in readable form", async () => {
    const { run } = await dummyRun();
    const text = formatTimeline(runsDir, run.runId);
    expect(text).toContain("status failed");
    expect(text).toContain("✓ context");
    expect(text).toContain("llm  ollama deepseek-v4.1-flash@sha256:01234");
    expect(text).toContain("1200→300 tok");
    expect(text).toContain("api  dataforseo serp/google/organic/live/advanced  miss  200");
    expect(text).toContain("✗ cluster FAILED");
    expect(text).toContain("Error: SERP overlap failed");
    expect(text).toContain("Failed: cluster");
  });

  it("resolves latest and prefixes", async () => {
    const { run } = await dummyRun();
    expect(listRuns(runsDir)).toHaveLength(1);
    expect(resolveRunId(runsDir, "latest")).toBe(run.runId);
    expect(resolveRunId(runsDir, run.runId.slice(0, 10))).toBe(run.runId);
    expect(() => resolveRunId(runsDir, "nope")).toThrow(/no run matches/);
  });
});

describe("redact", () => {
  it("keeps token counts but masks auth tokens", () => {
    expect(
      redact({ inputTokens: 5, outputTokens: 7, access_token: "abcdefghij", token: "x" }),
    ).toEqual({ inputTokens: 5, outputTokens: 7, access_token: REDACTED, token: REDACTED });
  });

  it("masks secret-looking keys and known values, deep", () => {
    const out = redact(
      { headers: { Authorization: "Basic xyz" }, nested: [{ note: `use ${SECRET} here` }], n: 1 },
      [SECRET],
    );
    expect(out).toEqual({
      headers: { Authorization: REDACTED },
      nested: [{ note: `use ${REDACTED} here` }],
      n: 1,
    });
  });
});
