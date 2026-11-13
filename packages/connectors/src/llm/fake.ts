import type { ChatRequest, ChatResponse, LlmProvider } from "./types.ts";

type Reply = string | Error | ((req: ChatRequest) => string | Error);

/**
 * Scripted provider for tests and dry runs (`--provider fake`). Proves the provider switch
 * and lets the pipeline run end-to-end without spending anything.
 */
export class FakeProvider implements LlmProvider {
  readonly name = "fake";
  readonly endpoint = "fake://chat";
  readonly requests: ChatRequest[] = [];
  private readonly replies: Reply[];

  constructor(
    replies: Reply[] = ['{"ok":true}'],
    private readonly fallback?: Reply,
  ) {
    this.replies = [...replies];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    const next = this.replies.length > 0 ? this.replies.shift() : this.fallback;
    const out = typeof next === "function" ? next(req) : next;
    if (out instanceof Error) throw out;
    if (out === undefined) throw new Error("FakeProvider ran out of scripted replies");
    const inputTokens = req.messages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0);
    return {
      content: out,
      model: req.model,
      usage: { inputTokens, outputTokens: Math.ceil(out.length / 4) },
      timings: { done_reason: "stop" },
      raw: { message: { role: "assistant", content: out } },
      requestBody: { model: req.model, messages: req.messages },
    };
  }

  async modelDigest(): Promise<string> {
    return "fake:0000000000000000";
  }
}
