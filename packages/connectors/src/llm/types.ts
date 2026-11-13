export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PromptTemplate {
  id: string;
  version: string;
}

export interface GenerationParams {
  temperature?: number;
  topP?: number;
  seed?: number;
  maxTokens?: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Which prompt produced these messages; logged with every call (ADR 0009). */
  template: PromptTemplate;
  params?: GenerationParams;
  /** Ask the provider for JSON output; pass a JSON schema object to constrain it. */
  json?: boolean | Record<string, unknown>;
}

export interface ChatResponse {
  content: string;
  /** Model name as the provider reported it. */
  model: string;
  usage: { inputTokens?: number; outputTokens?: number };
  /** Provider timings and stop reason, e.g. Ollama total_duration, eval_count, done_reason. */
  timings: Record<string, number | string>;
  /** The full response body, saved to the run for troubleshooting. */
  raw: unknown;
  /** The full request body as sent (secrets are redacted when written). */
  requestBody: unknown;
}

export interface LlmProvider {
  readonly name: string;
  readonly endpoint: string;
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  /** Exact model version (e.g. Ollama digest), if the provider can tell. */
  modelDigest?(model: string): Promise<string | undefined>;
}

export class LlmProviderError extends Error {
  override name = "LlmProviderError";
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number | "network",
    readonly retryable: boolean,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** USD per million tokens. Ollama Cloud is a subscription, so this is optional. */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}
