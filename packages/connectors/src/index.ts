/** DataforSEO, GSC, WordPress and LLM providers (issues #10, #11, #14, #15). */
export { FileCache, requestHash, stableStringify } from "./dataforseo/cache.ts";
export {
  BudgetExceededError,
  DataforseoClient,
  DataforseoError,
  type DataforseoOptions,
  LiveCallBlockedError,
  type SerpBatchResult,
} from "./dataforseo/client.ts";
export {
  type DfsLocation,
  findCity,
  type MarketParams,
  marketParams,
} from "./dataforseo/locations.ts";
export * from "./dataforseo/parse.ts";
export * from "./dataforseo/url.ts";
export {
  GscClient,
  type GscDimension,
  GscError,
  type GscOptions,
  type GscQuery,
  type GscRow,
  loadServiceAccount,
  type ServiceAccount,
} from "./gsc/client.ts";
export {
  type GenerateOptions,
  LlmClient,
  type LlmClientOptions,
  LlmOutputError,
  promptHash,
} from "./llm/client.ts";
export { FakeProvider } from "./llm/fake.ts";
export { type OllamaOptions, OllamaProvider } from "./llm/ollama.ts";
export * from "./llm/types.ts";
export {
  type ApiCallInput,
  type CallRecorder,
  type LlmCallInput,
  type LlmRecorder,
  nullRecorder,
} from "./recorder.ts";

export {
  decodeEntities,
  htmlToText,
  kindOf,
  WordPressClient,
  WordPressError,
  type WordPressOptions,
} from "./wordpress/client.ts";

export const CONNECTORS_VERSION = "0.0.0";
