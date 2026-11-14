import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LlmCallInput, LlmRecorder } from "../recorder.ts";
import { LlmClient, LlmOutputError } from "./client.ts";
import { FakeProvider } from "./fake.ts";
import { OllamaProvider } from "./ollama.ts";
import type { ChatRequest } from "./types.ts";

function recorder() {
  const calls: LlmCallInput[] = [];
  const rec: LlmRecorder = {
    recordLlmCall: (c) => {
      calls.push(c);
      return String(calls.length);
    },
    log: { debug: () => {}, warn: () => {} },
  };
  return { rec, calls };
}

const req: ChatRequest = {
  model: "deepseek-v4.1-flash",
  messages: [
    { role: "system", content: "Antwoord in het Nederlands." },
    { role: "user", content: "Geef JSON met ok=true" },
  ],
  template: { id: "ping", version: "1" },
  params: { temperature: 0.2, seed: 42, maxTokens: 200 },
};

const ollamaReply = (content: string, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      model: "deepseek-v4.1-flash",
      message: { role: "assistant", content },
      done: true,
      done_reason: "stop",
      total_duration: 850_000_000,
      load_duration: 1_000_000,
      prompt_eval_count: 31,
      eval_count: 7,
      ...extra,
    }),
  );

describe("OllamaProvider", () => {
  it("maps params, JSON mode and auth, and reads usage and timings", async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const p = new OllamaProvider({
      host: "https://ollama.com/",
      apiKey: "key-123456789",
      fetchImpl: async (url, init) => {
        sent = { url: String(url), init: init ?? {} };
        return ollamaReply('{"ok":true}');
      },
    });
    const r = await p.chat({ ...req, json: true });
    expect(sent?.url).toBe("https://ollama.com/api/chat");
    expect((sent?.init.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer key-123456789",
    );
    expect(JSON.parse(String(sent?.init.body))).toMatchObject({
      model: "deepseek-v4.1-flash",
      stream: false,
      format: "json",
      options: { temperature: 0.2, seed: 42, num_predict: 200 },
    });
    expect(r.usage).toEqual({ inputTokens: 31, outputTokens: 7 });
    expect(r.timings).toMatchObject({
      total_duration: 850_000_000,
      eval_count: 7,
      done_reason: "stop",
    });
  });

  it("looks up the exact model digest from /api/tags", async () => {
    const p = new OllamaProvider({
      host: "http://localhost:11434",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            models: [{ name: "deepseek-v4.1-flash:latest", digest: "sha256:abc" }],
          }),
        ),
    });
    expect(await p.modelDigest("deepseek-v4.1-flash")).toBe("sha256:abc");
  });
});

describe("LlmClient", () => {
  it("records every call with model, digest, params, template, full request and response", async () => {
    const llm = new LlmClient({
      providers: [new FakeProvider(["hallo"])],
      defaultProvider: "fake",
      pricing: { "fake/deepseek-v4.1-flash": { inputPerMTok: 1, outputPerMTok: 2 } },
    });
    const { rec, calls } = recorder();
    const r = await llm.generate(req, rec);
    expect(r.content).toBe("hallo");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      provider: "fake",
      model: "deepseek-v4.1-flash",
      modelDigest: "fake:0000000000000000",
      params: { temperature: 0.2, seed: 42, maxTokens: 200, json: false },
      promptTemplate: { id: "ping", version: "1" },
      response: { message: { content: "hallo" } },
      providerTimings: { done_reason: "stop" },
      status: "ok",
      attempt: 1,
    });
    expect(calls[0]?.promptHash).toMatch(/^[0-9a-f]{32}$/);
    expect(calls[0]?.costUsd).toBeGreaterThan(0);
  });

  it("switches providers by name", async () => {
    const a = new FakeProvider(["from a"]);
    const b = new FakeProvider(["from b"]);
    Object.defineProperty(b, "name", { value: "other" });
    const llm = new LlmClient({ providers: [a, b], defaultProvider: "fake" });
    const { rec } = recorder();
    expect((await llm.generate(req, rec, { provider: "other" })).content).toBe("from b");
    await expect(llm.generate(req, rec, { provider: "nope" })).rejects.toThrow(
      /unknown LLM provider/,
    );
  });

  it("retries bad JSON and schema mismatches, recording each failed attempt", async () => {
    const llm = new LlmClient({
      providers: [new FakeProvider(["not json", '{"ok":"yes"}', '{"ok":true}'])],
      defaultProvider: "fake",
    });
    const { rec, calls } = recorder();
    const out = await llm.generateJson(req, z.object({ ok: z.boolean() }), rec);
    expect(out).toEqual({ ok: true });
    expect(calls.map((c) => [c.attempt, c.status])).toEqual([
      [1, "error"],
      [2, "error"],
      [3, "ok"],
    ]);
    expect(calls[0]?.error?.message).toMatch(/invalid JSON/);
    expect(calls[1]?.error?.message).toMatch(/schema mismatch/);
  });

  it("gives up after maxAttempts instead of returning bad data", async () => {
    const llm = new LlmClient({
      providers: [new FakeProvider([], "nope")],
      defaultProvider: "fake",
    });
    await expect(
      llm.generateJson(req, z.object({ ok: z.boolean() }), recorder().rec, { maxAttempts: 2 }),
    ).rejects.toBeInstanceOf(LlmOutputError);
  });

  it("counts an empty answer as failed: recorded as an error, retried, never returned", async () => {
    const llm = new LlmClient({
      providers: [new FakeProvider(["", "  \n", "Een echte alinea."])],
      defaultProvider: "fake",
    });
    const { rec, calls } = recorder();
    expect((await llm.generate(req, rec)).content).toBe("Een echte alinea.");
    expect(calls.map((c) => [c.attempt, c.status])).toEqual([
      [1, "error"],
      [2, "error"],
      [3, "ok"],
    ]);
    expect(calls[0]?.error).toEqual({
      name: "LlmOutputError",
      message: "empty answer (done_reason: stop)",
    });

    const silent = new LlmClient({
      providers: [new FakeProvider([], "")],
      defaultProvider: "fake",
    });
    await expect(silent.generate(req, recorder().rec, { maxAttempts: 2 })).rejects.toThrow(
      "no valid output after 2 attempts: empty answer",
    );
    await expect(
      silent.generateJson(req, z.object({ ok: z.boolean() }), recorder().rec),
    ).rejects.toThrow("empty answer");
  });

  it("counts an answer cut off at the token limit as failed", async () => {
    const replies = [
      ollamaReply('{"ok":tr', { done_reason: "length" }),
      ollamaReply("Een halve zin die midden in", { done_reason: "length" }),
      ollamaReply("Een hele zin."),
    ];
    const ollama = new OllamaProvider({
      host: "https://ollama.com",
      fetchImpl: async () => replies.shift() as Response,
    });
    Object.assign(ollama, { modelDigest: undefined });
    const llm = new LlmClient({ providers: [ollama], defaultProvider: "ollama" });
    const { rec, calls } = recorder();
    expect((await llm.generate(req, rec)).content).toBe("Een hele zin.");
    expect(calls.map((c) => c.status)).toEqual(["error", "error", "ok"]);
    expect(calls[1]?.error?.message).toBe(
      "answer cut off at the token limit (done_reason: length)",
    );
    // The cut-off text is still saved with the failed call, for troubleshooting (ADR 0009).
    expect(JSON.stringify(calls[1]?.response)).toContain("Een halve zin");
  });

  it("retries transport errors (5xx) and records the failed attempt with the response body", async () => {
    const replies = [
      new Response(JSON.stringify({ error: "overloaded" }), { status: 503 }),
      ollamaReply("ok"),
    ];
    const ollama = new OllamaProvider({
      host: "https://ollama.com",
      fetchImpl: async () => replies.shift() as Response,
    });
    Object.assign(ollama, { modelDigest: undefined });
    const llm = new LlmClient({
      providers: [ollama],
      defaultProvider: "ollama",
      sleep: async () => {},
    });
    const { rec, calls } = recorder();
    expect((await llm.generate(req, rec)).content).toBe("ok");
    expect(calls.map((c) => c.status)).toEqual(["error", "ok"]);
    expect(calls[0]?.error?.message).toMatch(/HTTP 503/);
    expect(calls[0]?.response).toEqual({ error: "overloaded" });
  });

  it("does not retry auth errors", async () => {
    let n = 0;
    const ollama = new OllamaProvider({
      host: "https://ollama.com",
      fetchImpl: async () => {
        n++;
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      },
    });
    Object.assign(ollama, { modelDigest: undefined });
    const llm = new LlmClient({
      providers: [ollama],
      defaultProvider: "ollama",
      sleep: async () => {},
    });
    await expect(llm.generate(req, recorder().rec)).rejects.toThrow(/401/);
    expect(n).toBe(1);
  });
});
