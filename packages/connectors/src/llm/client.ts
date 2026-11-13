import { createHash } from "node:crypto";
import { z } from "zod";
import { stableStringify } from "../dataforseo/cache.ts";
import type { LlmCallInput, LlmRecorder } from "../recorder.ts";
import {
  type ChatRequest,
  type ChatResponse,
  type LlmProvider,
  LlmProviderError,
  type ModelPricing,
} from "./types.ts";

export class LlmOutputError extends Error {
  override name = "LlmOutputError";
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
  }
}

export interface LlmClientOptions {
  providers: LlmProvider[];
  /** Provider name used when a request doesn't name one. */
  defaultProvider: string;
  /** Per "provider/model" pricing, for cost logging. */
  pricing?: Record<string, ModelPricing>;
  /** Retries for network errors, 429 and 5xx. */
  maxTransportRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface GenerateOptions {
  provider?: string;
}

export function promptHash(req: ChatRequest): string {
  return createHash("sha256")
    .update(
      stableStringify({
        model: req.model,
        messages: req.messages,
        params: req.params,
        json: req.json,
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

const errorInfo = (err: unknown) => ({
  name: err instanceof Error ? err.name : "Error",
  message: err instanceof Error ? err.message : String(err),
  ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
});

/**
 * The provider switch (ADR 0005). Every call, including failed attempts, is recorded with
 * the exact model, digest, params, prompt template, full request and response (ADR 0009).
 */
export class LlmClient {
  private readonly providers = new Map<string, LlmProvider>();
  private readonly digestCache = new Map<string, Promise<string | undefined>>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: LlmClientOptions) {
    for (const p of opts.providers) this.providers.set(p.name, p);
    if (!this.providers.has(opts.defaultProvider)) {
      throw new Error(`default provider "${opts.defaultProvider}" is not registered`);
    }
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private provider(name?: string): LlmProvider {
    const key = name ?? this.opts.defaultProvider;
    const p = this.providers.get(key);
    if (!p)
      throw new Error(
        `unknown LLM provider "${key}" (have: ${[...this.providers.keys()].join(", ")})`,
      );
    return p;
  }

  private async digest(
    p: LlmProvider,
    model: string,
    rec: LlmRecorder,
  ): Promise<string | undefined> {
    if (!p.modelDigest) return undefined;
    const key = `${p.name}/${model}`;
    let d = this.digestCache.get(key);
    if (!d) {
      d = p.modelDigest(model).catch((err) => {
        rec.log.warn("could not look up model digest", {
          provider: p.name,
          model,
          error: errorInfo(err).message,
        });
        return undefined;
      });
      this.digestCache.set(key, d);
    }
    return d;
  }

  private cost(p: LlmProvider, model: string, usage: ChatResponse["usage"]): number | undefined {
    const price = this.opts.pricing?.[`${p.name}/${model}`];
    if (!price) return undefined;
    const usd =
      ((usage.inputTokens ?? 0) * price.inputPerMTok +
        (usage.outputTokens ?? 0) * price.outputPerMTok) /
      1e6;
    return Math.round(usd * 1e6) / 1e6;
  }

  /** One chat call with transport retries. Returns the response; each attempt is recorded. */
  async generate(
    req: ChatRequest,
    rec: LlmRecorder,
    opts: GenerateOptions = {},
  ): Promise<ChatResponse> {
    return this.call(req, rec, opts, 1).then((r) => r.response);
  }

  private async call(
    req: ChatRequest,
    rec: LlmRecorder,
    opts: GenerateOptions,
    attemptBase: number,
    validate?: (content: string) => string | null,
  ): Promise<{ response: ChatResponse; attempts: number; validationError: string | null }> {
    const p = this.provider(opts.provider);
    const digest = await this.digest(p, req.model, rec);
    const hash = promptHash(req);
    const maxRetries = this.opts.maxTransportRetries ?? 2;
    for (let t = 0; ; t++) {
      const attempt = attemptBase + t;
      const startedAt = new Date().toISOString();
      const t0 = performance.now();
      const base: Omit<LlmCallInput, "status" | "latencyMs"> = {
        provider: p.name,
        endpoint: p.endpoint,
        model: req.model,
        ...(digest ? { modelDigest: digest } : {}),
        params: { ...req.params, json: req.json ?? false },
        promptTemplate: req.template,
        promptHash: hash,
        request: { messages: req.messages },
        attempt,
        startedAt,
      };
      try {
        const response = await p.chat(req);
        const validationError = validate ? validate(response.content) : null;
        const costUsd = this.cost(p, req.model, response.usage);
        rec.recordLlmCall({
          ...base,
          request: response.requestBody,
          response: response.raw,
          usage: response.usage,
          providerTimings: response.timings,
          ...(costUsd !== undefined ? { costUsd } : {}),
          latencyMs: Math.round(performance.now() - t0),
          status: validationError ? "error" : "ok",
          ...(validationError
            ? { error: { name: "LlmOutputError", message: validationError } }
            : {}),
        });
        return { response, attempts: t + 1, validationError };
      } catch (err) {
        rec.recordLlmCall({
          ...base,
          ...(err instanceof LlmProviderError && err.body !== undefined
            ? { response: err.body }
            : {}),
          latencyMs: Math.round(performance.now() - t0),
          status: "error",
          error: errorInfo(err),
        });
        const retryable = err instanceof LlmProviderError && err.retryable;
        if (!retryable || t >= maxRetries) throw err;
        rec.log.warn("LLM call failed, retrying", {
          provider: p.name,
          model: req.model,
          attempt,
          error: errorInfo(err).message,
        });
        await this.sleep(1000 * 2 ** t);
      }
    }
  }

  /**
   * JSON output validated against a Zod schema. Invalid JSON or a schema mismatch is
   * recorded as a failed attempt and retried; after maxAttempts it throws. Never returns bad data.
   */
  async generateJson<S extends z.ZodType>(
    req: ChatRequest,
    schema: S,
    rec: LlmRecorder,
    opts: GenerateOptions & { maxAttempts?: number } = {},
  ): Promise<z.output<S>> {
    const maxAttempts = opts.maxAttempts ?? 3;
    let parsed: z.output<S> | undefined;
    const validate = (content: string): string | null => {
      let value: unknown;
      try {
        value = JSON.parse(content);
      } catch (err) {
        return `invalid JSON: ${(err as Error).message}`;
      }
      const r = schema.safeParse(value);
      if (!r.success) return `schema mismatch: ${z.prettifyError(r.error)}`;
      parsed = r.data;
      return null;
    };
    let attempt = 1;
    let lastError = "";
    while (attempt <= maxAttempts) {
      const r = await this.call({ ...req, json: req.json ?? true }, rec, opts, attempt, validate);
      if (!r.validationError) return parsed as z.output<S>;
      lastError = r.validationError;
      rec.log.warn("LLM output failed validation", { attempt, maxAttempts, error: lastError });
      attempt += r.attempts;
    }
    throw new LlmOutputError(
      `no valid output after ${maxAttempts} attempts: ${lastError}`,
      maxAttempts,
    );
  }
}
