import { withUserAgent } from "../http.ts";
import {
  type ChatRequest,
  type ChatResponse,
  type LlmProvider,
  LlmProviderError,
} from "./types.ts";

export interface OllamaOptions {
  /** https://ollama.com for Ollama Cloud, http://localhost:11434 for a local server. */
  host: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const num = (v: unknown) => (typeof v === "number" ? v : undefined);

/** Ollama /api/chat (non-streaming). Docs: github.com/ollama/ollama/blob/main/docs/api.md */
export class OllamaProvider implements LlmProvider {
  readonly name = "ollama";
  readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private digests: Map<string, string> | null = null;

  constructor(private readonly opts: OllamaOptions) {
    this.endpoint = `${opts.host.replace(/\/$/, "")}/api/chat`;
    this.fetchImpl = withUserAgent(opts.fetchImpl ?? fetch);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.apiKey) h.Authorization = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const p = req.params ?? {};
    const options: Record<string, number> = {};
    if (p.temperature !== undefined) options.temperature = p.temperature;
    if (p.topP !== undefined) options.top_p = p.topP;
    if (p.seed !== undefined) options.seed = p.seed;
    if (p.maxTokens !== undefined) options.num_predict = p.maxTokens;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: false,
      options,
    };
    if (req.json) body.format = req.json === true ? "json" : req.json;

    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 120_000);
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      throw new LlmProviderError(
        `network error: ${(err as Error).message}`,
        this.name,
        "network",
        true,
      );
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { body: text };
    }
    if (!res.ok) {
      throw new LlmProviderError(
        `HTTP ${res.status}: ${String(json.error ?? text).slice(0, 300)}`,
        this.name,
        res.status,
        res.status === 429 || res.status >= 500,
        json,
      );
    }

    const message = (json.message ?? {}) as { content?: string };
    const timings: Record<string, number | string> = {};
    for (const k of [
      "total_duration",
      "load_duration",
      "prompt_eval_count",
      "prompt_eval_duration",
      "eval_count",
      "eval_duration",
    ]) {
      const v = num(json[k]);
      if (v !== undefined) timings[k] = v;
    }
    if (typeof json.done_reason === "string") timings.done_reason = json.done_reason;

    const usage: ChatResponse["usage"] = {};
    const inTok = num(json.prompt_eval_count);
    const outTok = num(json.eval_count);
    if (inTok !== undefined) usage.inputTokens = inTok;
    if (outTok !== undefined) usage.outputTokens = outTok;

    return {
      content: message.content ?? "",
      model: typeof json.model === "string" ? json.model : req.model,
      usage,
      timings,
      raw: json,
      requestBody: body,
    };
  }

  /** Digest from /api/tags, fetched once per provider. Undefined if the model isn't listed. */
  async modelDigest(model: string): Promise<string | undefined> {
    if (!this.digests) {
      this.digests = new Map();
      const res = await this.fetchImpl(`${this.opts.host.replace(/\/$/, "")}/api/tags`, {
        headers: this.headers(),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          models?: { name?: string; model?: string; digest?: string }[];
        };
        for (const m of json.models ?? []) {
          if (m.digest) {
            if (m.name) this.digests.set(m.name, m.digest);
            if (m.model) this.digests.set(m.model, m.digest);
          }
        }
      }
    }
    return this.digests.get(model) ?? this.digests.get(`${model}:latest`);
  }
}
