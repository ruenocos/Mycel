import { createHash } from "node:crypto";
import { z } from "zod";
import { stableStringify } from "../dataforseo/cache.ts";
import { BudgetExceededError } from "../dataforseo/client.ts";
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
  /** Per "provider/model" pricing, for cost logging and the budget. */
  pricing?: Record<string, ModelPricing>;
  /**
   * Cost cap for this client, in dollars. A call is refused when what was spent plus the price
   * of its prompt would pass it. Only priced models count: Ollama Cloud is a subscription.
   */
  budgetUsd?: number;
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
 * Why an answer can't be used at all, whatever was asked for. A model that returns nothing (a
 * thinking model that spent its whole token budget thinking, a provider hiccup) or stops at the
 * token limit still answers HTTP 200; without this check that counted as a good call.
 */
function unusable(response: ChatResponse): string | null {
  const reason = response.timings.done_reason;
  if (!response.content.trim()) {
    return `empty answer${reason ? ` (done_reason: ${reason})` : ""}`;
  }
  if (reason === "length") return "answer cut off at the token limit (done_reason: length)";
  return null;
}

/**
 * The provider switch (ADR 0005). Every call, including failed attempts, is recorded with
 * the exact model, digest, params, prompt template, full request and response (ADR 0009).
 */
export class LlmClient {
  private readonly providers = new Map<string, LlmProvider>();
  private readonly digestCache = new Map<string, Promise<string | undefined>>();
  private readonly sleep: (ms: number) => Promise<void>;
  private spent = 0;

  constructor(private readonly opts: LlmClientOptions) {
    const cap = opts.budgetUsd;
    if (cap !== undefined && !(Number.isFinite(cap) && cap > 0)) {
      throw new RangeError(`budgetUsd must be a positive number of dollars, got ${cap}`);
    }
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

  /** What the calls through this client cost so far, in dollars (priced models only). */
  get spentUsd(): number {
    return Math.round(this.spent * 1e6) / 1e6;
  }

  /** Refuses a call that would pass the budget: what was spent plus its prompt at the input price. */
  private checkBudget(p: LlmProvider, req: ChatRequest): void {
    const cap = this.opts.budgetUsd;
    const price = this.opts.pricing?.[`${p.name}/${req.model}`];
    if (cap === undefined || !price) return;
    const promptTokens = req.messages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0);
    const next = (promptTokens * price.inputPerMTok) / 1e6;
    if (this.spent + next > cap) {
      throw new BudgetExceededError(
        `LLM budget of $${cap} reached ($${this.spentUsd} spent, the next call needs about $${next.toFixed(4)})`,
      );
    }
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

  /**
   * Free-text output. An empty answer, or one cut off at the token limit, is recorded as a
   * failed attempt and retried; after maxAttempts it throws. Each attempt is recorded.
   */
  async generate(
    req: ChatRequest,
    rec: LlmRecorder,
    opts: GenerateOptions & { maxAttempts?: number } = {},
  ): Promise<ChatResponse> {
    return this.usable(req, rec, opts);
  }

  /** Calls until an answer passes `unusable` and `validate`, or the attempts run out. */
  private async usable(
    req: ChatRequest,
    rec: LlmRecorder,
    opts: GenerateOptions & { maxAttempts?: number },
    validate?: (content: string) => string | null,
  ): Promise<ChatResponse> {
    const maxAttempts = opts.maxAttempts ?? 3;
    let attempt = 1;
    let lastError = "";
    while (attempt <= maxAttempts) {
      const r = await this.call(req, rec, opts, attempt, validate);
      if (!r.validationError) return r.response;
      lastError = r.validationError;
      rec.log.warn("LLM output failed validation", { attempt, maxAttempts, error: lastError });
      attempt += r.attempts;
    }
    throw new LlmOutputError(
      `no valid output after ${maxAttempts} attempts: ${lastError}`,
      maxAttempts,
    );
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
      // Outside the try: a refused call never went out, so it is no failed attempt.
      this.checkBudget(p, req);
      try {
        const response = await p.chat(req);
        const validationError = unusable(response) ?? validate?.(response.content) ?? null;
        const costUsd = this.cost(p, req.model, response.usage);
        if (costUsd) this.spent += costUsd;
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
    await this.usable({ ...req, json: req.json ?? true }, rec, opts, validate);
    return parsed as z.output<S>;
  }
}
