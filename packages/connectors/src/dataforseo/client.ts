import type { Market } from "@mycel/schema";
import type { CallRecorder } from "../recorder.ts";
import { FileCache, requestHash } from "./cache.ts";
import { marketParams } from "./locations.ts";
import {
  type CompetitorDomain,
  type KeywordIdea,
  parseCompetitorDomains,
  parseKeywordSuggestions,
  parseRankedKeywords,
  parseRelatedKeywords,
  parseSerp,
  type RankedKeyword,
  type SerpResult,
} from "./parse.ts";

export class DataforseoError extends Error {
  override name = "DataforseoError";
  constructor(
    message: string,
    readonly endpoint: string,
    readonly statusCode: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class BudgetExceededError extends Error {
  override name = "BudgetExceededError";
}

export class LiveCallBlockedError extends Error {
  override name = "LiveCallBlockedError";
}

export interface DataforseoOptions {
  login: string;
  password: string;
  cacheDir: string;
  /** Hard ceiling for this client's paid calls (cache hits are free). */
  budgetUsd: number;
  /** Paid SERP fetches only run with this flag; otherwise SERPs must come from cache (CLAUDE.md). */
  allowLiveSerp?: boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** Standard-queue SERP polling. */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

interface DfsResponse {
  status_code: number;
  status_message: string;
  cost?: number;
  tasks?: {
    id?: string;
    status_code: number;
    status_message: string;
    cost?: number;
    result?: unknown[] | null;
  }[];
}

const SERVICE = "dataforseo";
const TASK_PENDING = new Set([20100, 40601, 40602]); // created, handed, in queue

export class DataforseoClient {
  private readonly cache: FileCache;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly auth: string;
  private spent = 0;

  constructor(private readonly opts: DataforseoOptions) {
    this.cache = new FileCache(opts.cacheDir);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = opts.baseUrl ?? "https://api.dataforseo.com/v3";
    this.auth = `Basic ${Buffer.from(`${opts.login}:${opts.password}`).toString("base64")}`;
  }

  /** USD spent on paid calls by this client so far. */
  get spentUsd(): number {
    return Math.round(this.spent * 1e6) / 1e6;
  }

  async relatedKeywords(
    seed: string,
    market: Market,
    rec: CallRecorder,
    opts: { depth?: number; limit?: number } = {},
  ): Promise<KeywordIdea[]> {
    const endpoint = "dataforseo_labs/google/related_keywords/live";
    const payload = {
      keyword: seed,
      ...marketParams(market),
      depth: opts.depth ?? 2,
      limit: opts.limit ?? 100,
    };
    return parseRelatedKeywords(await this.cachedLive(endpoint, payload, rec));
  }

  async keywordSuggestions(
    seed: string,
    market: Market,
    rec: CallRecorder,
    opts: { limit?: number } = {},
  ): Promise<KeywordIdea[]> {
    const endpoint = "dataforseo_labs/google/keyword_suggestions/live";
    const payload = { keyword: seed, ...marketParams(market), limit: opts.limit ?? 100 };
    return parseKeywordSuggestions(await this.cachedLive(endpoint, payload, rec));
  }

  async rankedKeywords(
    target: string,
    market: Market,
    rec: CallRecorder,
    opts: { limit?: number } = {},
  ): Promise<RankedKeyword[]> {
    const endpoint = "dataforseo_labs/google/ranked_keywords/live";
    const payload = { target, ...marketParams(market), limit: opts.limit ?? 100 };
    return parseRankedKeywords(await this.cachedLive(endpoint, payload, rec));
  }

  /** Domains that rank for the same keywords as `target` (steps 1-6: who are the competitors). */
  async competitorDomains(
    target: string,
    market: Market,
    rec: CallRecorder,
    opts: { limit?: number } = {},
  ): Promise<CompetitorDomain[]> {
    const endpoint = "dataforseo_labs/google/competitors_domain/live";
    const payload = { target, ...marketParams(market), limit: opts.limit ?? 20 };
    return parseCompetitorDomains(await this.cachedLive(endpoint, payload, rec), target);
  }

  /**
   * Organic SERP via the standard queue (task_post + task_get): cheaper than live, and the
   * standard queue resolves Google's goto redirect URLs that live mode often leaves unresolved.
   */
  async serpOrganic(
    keyword: string,
    market: Market,
    rec: CallRecorder,
    opts: { depth?: number; device?: "desktop" | "mobile" } = {},
  ): Promise<SerpResult> {
    const endpoint = "serp/google/organic/task_post";
    const payload = {
      keyword,
      ...marketParams(market),
      device: opts.device ?? "desktop",
      depth: opts.depth ?? 10,
    };
    const result = await this.cached(endpoint, payload, rec, async (hash) => {
      if (!this.opts.allowLiveSerp) {
        throw new LiveCallBlockedError(
          `SERP for "${keyword}" is not cached and paid SERP calls are off (enable allowLiveSerp)`,
        );
      }
      const posted = await this.request("POST", endpoint, [payload], rec, hash);
      const task = posted.tasks?.[0];
      if (!task?.id)
        throw new DataforseoError(
          "task_post returned no task id",
          endpoint,
          task?.status_code ?? 0,
          false,
        );
      const costUsd = task.cost ?? posted.cost ?? 0;
      this.spent += costUsd;
      const got = await this.pollTask(
        `serp/google/organic/task_get/advanced/${task.id}`,
        rec,
        hash,
      );
      return { result: got, costUsd };
    });
    return parseSerp(keyword, result);
  }

  private async pollTask(endpoint: string, rec: CallRecorder, hash: string): Promise<unknown> {
    const interval = this.opts.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + (this.opts.pollTimeoutMs ?? 10 * 60_000);
    for (;;) {
      const res = await this.request("GET", endpoint, undefined, rec, hash, { allowPending: true });
      const task = res.tasks?.[0];
      if (task && task.status_code === 20000) return task.result?.[0] ?? null;
      if (Date.now() > deadline) {
        throw new DataforseoError(
          `task not ready before timeout`,
          endpoint,
          task?.status_code ?? 0,
          true,
        );
      }
      rec.log.debug("serp task pending", { endpoint, status: task?.status_code });
      await this.sleep(interval);
    }
  }

  private async cachedLive(endpoint: string, payload: Record<string, unknown>, rec: CallRecorder) {
    return this.cached(endpoint, payload, rec, async (hash) => {
      const res = await this.request("POST", endpoint, [payload], rec, hash);
      const task = res.tasks?.[0];
      const costUsd = task?.cost ?? res.cost ?? 0;
      this.spent += costUsd;
      return { result: task?.result?.[0] ?? null, costUsd };
    });
  }

  /** Cache by request hash; a hit costs nothing and is still logged. */
  private async cached(
    endpoint: string,
    payload: Record<string, unknown>,
    rec: CallRecorder,
    fetcher: (hash: string) => Promise<{ result: unknown; costUsd: number }>,
  ): Promise<unknown> {
    const hash = requestHash(endpoint, payload);
    const hit = this.cache.get(hash);
    if (hit) {
      rec.recordApiCall({
        service: SERVICE,
        endpoint,
        requestHash: hash,
        cache: "hit",
        costUsd: 0,
        latencyMs: 0,
        status: 200,
        startedAt: new Date().toISOString(),
      });
      return hit.result;
    }
    if (this.spent >= this.opts.budgetUsd) {
      throw new BudgetExceededError(
        `DataforSEO budget of $${this.opts.budgetUsd} reached ($${this.spentUsd} spent); not calling ${endpoint}`,
      );
    }
    const { result, costUsd } = await fetcher(hash);
    this.cache.set(hash, {
      endpoint,
      payload,
      fetchedAt: new Date().toISOString(),
      costUsd,
      result,
    });
    return result;
  }

  /** One HTTP call with retries on network errors, 429, 5xx and DataforSEO 5xxxx codes. Each attempt is logged. */
  private async request(
    method: "GET" | "POST",
    endpoint: string,
    body: unknown,
    rec: CallRecorder,
    hash: string,
    opts: { allowPending?: boolean } = {},
  ): Promise<DfsResponse> {
    const maxRetries = this.opts.maxRetries ?? 3;
    for (let attempt = 1; ; attempt++) {
      const startedAt = new Date().toISOString();
      const t0 = performance.now();
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/${endpoint}`, {
          method,
          headers: { Authorization: this.auth, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (res.status === 429 || res.status >= 500) {
          throw new DataforseoError(`HTTP ${res.status}`, endpoint, res.status, true);
        }
        const json = (await res.json()) as DfsResponse;
        const task = json.tasks?.[0];
        const code = task?.status_code ?? json.status_code;
        const pending = opts.allowPending && TASK_PENDING.has(code);
        const ok = json.status_code === 20000 && (code === 20000 || code === 20100 || pending);
        rec.recordApiCall({
          service: SERVICE,
          endpoint,
          requestHash: hash,
          cache: "miss",
          costUsd: method === "POST" ? (task?.cost ?? json.cost ?? 0) : 0,
          latencyMs: Math.round(performance.now() - t0),
          status: ok ? res.status : "error",
          ...(ok
            ? {}
            : {
                error: {
                  name: "DataforseoError",
                  message: `${code} ${task?.status_message ?? json.status_message}`,
                },
              }),
          startedAt,
        });
        if (ok) return json;
        throw new DataforseoError(
          `${code} ${task?.status_message ?? json.status_message}`,
          endpoint,
          code,
          code >= 50000,
        );
      } catch (err) {
        const retryable = !(err instanceof DataforseoError) || err.retryable;
        if (!(err instanceof DataforseoError) || err.statusCode < 10000) {
          // network error or HTTP-level failure: not recorded above yet
          rec.recordApiCall({
            service: SERVICE,
            endpoint,
            requestHash: hash,
            cache: "miss",
            costUsd: 0,
            latencyMs: Math.round(performance.now() - t0),
            status: "error",
            error: { name: (err as Error).name, message: (err as Error).message },
            startedAt,
          });
        }
        if (!retryable || attempt > maxRetries) throw err;
        rec.log.warn("dataforseo call failed, retrying", {
          endpoint,
          attempt,
          error: (err as Error).message,
        });
        await this.sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }
}
