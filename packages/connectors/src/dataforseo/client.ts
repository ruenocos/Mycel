import { join } from "node:path";
import type { Market } from "@mycel/schema";
import { withUserAgent } from "../http.ts";
import type { CallRecorder } from "../recorder.ts";
import { type CacheEntry, FileCache, requestHash } from "./cache.ts";
import { SpendLedger } from "./ledger.ts";
import { type DfsLocation, findCity, type MarketParams, marketParams } from "./locations.ts";
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
import { PENDING_MAX_AGE_MS, type PendingTask, PendingTasks } from "./pending.ts";
import { SERP_TASK_ENDPOINT, serpTaskPayload } from "./plan.ts";

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
  /**
   * Ceiling for the calendar month across all runs that share this cache dir (ADR 0004). Spend
   * is always written to <cacheDir>/ledger; without this option it just isn't capped.
   */
  monthlyBudgetUsd?: number;
  /** Clock for the monthly ledger (tests). */
  now?: () => Date;
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
    data?: { tag?: string };
    result?: unknown[] | null;
  }[];
}

/** Many SERPs at once: what came back, what was off-limits, what failed. */
export interface SerpBatchResult {
  serps: Map<string, SerpResult>;
  /** Not cached, and paid SERP calls are off. */
  blocked: string[];
  failed: { keyword: string; error: string }[];
}

const SERVICE = "dataforseo";
const TASK_PENDING = new Set([20100, 40601, 40602]); // created, handed, in queue
/** A task whose task_get keeps failing is left for the next run after this many tries. */
const COLLECT_MAX_ERRORS = 3;
const KEPT = "the task id is saved, so the next run collects it without paying again";

export class DataforseoClient {
  private readonly cache: FileCache;
  private readonly tasks: PendingTasks;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly auth: string;
  private readonly ledger: SpendLedger;
  private spent = 0;
  /** Estimated cost of paid calls that are in flight right now. */
  private reserved = 0;
  /** Highest price seen per endpoint in this run: the estimate for the next call. */
  private readonly price = new Map<string, number>();
  /** Endpoints whose first paid call is still out, so its price isn't known yet. */
  private readonly pricing = new Map<string, Promise<void>>();
  /** SERP location per "country|city", looked up once per run. */
  private readonly serpPlaces = new Map<string, Promise<MarketParams>>();

  constructor(private readonly opts: DataforseoOptions) {
    for (const [name, value] of [
      ["budgetUsd", opts.budgetUsd],
      ["monthlyBudgetUsd", opts.monthlyBudgetUsd],
    ] as const) {
      if (value !== undefined && !(Number.isFinite(value) && value >= 0)) {
        // NaN would switch the cap off silently: `spent >= NaN` is never true.
        throw new RangeError(`DataforSEO ${name} must be a number of dollars, got ${value}`);
      }
    }
    this.cache = new FileCache(opts.cacheDir);
    this.tasks = new PendingTasks(join(opts.cacheDir, "pending"));
    this.ledger = new SpendLedger(join(opts.cacheDir, "ledger"), opts.now, (month) =>
      [...this.cache.entries()]
        .filter((e) => e.costUsd > 0 && e.fetchedAt.startsWith(month))
        .map((e) => ({
          at: e.fetchedAt,
          endpoint: e.endpoint,
          requestHash: e.hash,
          costUsd: e.costUsd,
        })),
    );
    // Load (and, the first time in a month, seed) the ledger before this run adds to it.
    this.ledger.spentThisMonth();
    this.fetchImpl = withUserAgent(opts.fetchImpl ?? fetch);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = opts.baseUrl ?? "https://api.dataforseo.com/v3";
    this.auth = `Basic ${Buffer.from(`${opts.login}:${opts.password}`).toString("base64")}`;
  }

  /** USD spent on paid calls by this client so far. */
  get spentUsd(): number {
    return Math.round(this.spent * 1e6) / 1e6;
  }

  /** USD spent this calendar month by every run that shares this cache dir. */
  get spentThisMonthUsd(): number {
    return this.ledger.spentThisMonth();
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
   * The task id is saved at post time; a run that stops before the result is in collects the
   * same task next time instead of paying again.
   */
  async serpOrganic(
    keyword: string,
    market: Market,
    rec: CallRecorder,
    opts: { depth?: number; device?: "desktop" | "mobile" } = {},
  ): Promise<SerpResult> {
    const endpoint = SERP_TASK_ENDPOINT;
    const payload = serpTaskPayload(keyword, await this.serpParams(market, rec), opts);
    const hash = requestHash(endpoint, payload);
    const hit = this.hit(endpoint, hash, rec);
    if (hit) return parseSerp(keyword, hit.result);

    /** The task's result. A task that failed for good is forgotten, so it gets posted fresh. */
    const collect = async (t: PendingTask): Promise<unknown> => {
      try {
        return await this.pollTask(`serp/google/organic/task_get/advanced/${t.taskId}`, rec, hash);
      } catch (err) {
        if (err instanceof DataforseoError && !err.retryable) this.tasks.delete(hash);
        throw err;
      }
    };
    let task = this.savedTask(hash, rec);
    let result: unknown;
    if (task) {
      try {
        result = await collect(task);
      } catch (err) {
        // Still waiting, or the network is down: keep the saved task. Gone for good: post anew.
        if (!(err instanceof DataforseoError) || err.retryable) throw err;
        rec.log.warn("saved SERP task can't be collected any more, posting it again", {
          taskId: task.taskId,
          message: err.message,
        });
        task = null;
      }
    }
    if (!task) {
      if (!this.opts.allowLiveSerp) {
        throw new LiveCallBlockedError(
          `SERP for "${keyword}" is not cached and paid SERP calls are off (enable allowLiveSerp)`,
        );
      }
      task = await this.postSerpTask(endpoint, payload, hash, rec);
      result = await collect(task);
    }
    this.cache.set(hash, {
      endpoint,
      payload,
      fetchedAt: new Date().toISOString(),
      costUsd: task.costUsd,
      result,
    });
    this.tasks.delete(hash);
    return parseSerp(keyword, result);
  }

  /**
   * Where to ask Google from. A market with a city gets that city's SERP (a physio in Utrecht
   * competes in Utrecht, not in the Netherlands); DataforSEO's free location list, cached like
   * any response, turns the name into a code. A city that isn't found, or that matches more than
   * one place, falls back to the country with a warning.
   */
  private serpParams(market: Market, rec: CallRecorder): Promise<MarketParams> {
    const country = marketParams(market);
    if (!market.city) return Promise.resolve(country);
    const key = `${market.country}|${market.city}`;
    let known = this.serpPlaces.get(key);
    if (!known) {
      known = this.cityParams(market, country, rec);
      this.serpPlaces.set(key, known);
      // A failed lookup isn't remembered: the next SERP call tries again.
      known.catch(() => this.serpPlaces.delete(key));
    }
    return known;
  }

  private async cityParams(
    market: Market,
    country: MarketParams,
    rec: CallRecorder,
  ): Promise<MarketParams> {
    const endpoint = `serp/google/locations/${market.country.toLowerCase()}`;
    const hash = requestHash(endpoint, {});
    let locations = this.hit(endpoint, hash, rec)?.result as DfsLocation[] | undefined;
    if (!locations) {
      const res = await this.request("GET", endpoint, undefined, rec, hash);
      locations = (res.tasks?.[0]?.result ?? []) as DfsLocation[];
      this.cache.set(hash, {
        endpoint,
        payload: {},
        fetchedAt: new Date().toISOString(),
        costUsd: 0,
        result: locations,
      });
    }
    const { match, candidates } = findCity(locations, market);
    if (!match) {
      rec.log.warn(
        candidates.length
          ? "more than one place has this city name; SERPs use the country. Add the region to the market's city"
          : "city not in DataforSEO's location list; SERPs use the country",
        { city: market.city, candidates: candidates.map((c) => c.location_name).slice(0, 5) },
      );
      return country;
    }
    rec.log.debug("SERPs are fetched for the market's city", {
      city: market.city,
      location: match.location_name,
      locationCode: match.location_code,
    });
    return { ...country, location_code: match.location_code };
  }

  private async postSerpTask(
    endpoint: string,
    payload: Record<string, unknown>,
    hash: string,
    rec: CallRecorder,
  ): Promise<PendingTask> {
    return this.paid(endpoint, hash, `not posting the SERP task`, async () => {
      const posted = await this.request("POST", endpoint, [payload], rec, hash);
      const created = posted.tasks?.[0];
      if (!created?.id)
        throw new DataforseoError(
          "task_post returned no task id",
          endpoint,
          created?.status_code ?? 0,
          false,
        );
      const task: PendingTask = {
        taskId: created.id,
        endpoint,
        payload,
        postedAt: new Date().toISOString(),
        costUsd: created.cost ?? posted.cost ?? 0,
      };
      this.tasks.set(hash, task);
      return { value: task, costUsd: task.costUsd };
    });
  }

  /** A posted task that still waits for its result, unless it is too old to still exist. */
  private savedTask(hash: string, rec: CallRecorder): PendingTask | null {
    const task = this.tasks.get(hash);
    if (!task) return null;
    if (Date.now() - Date.parse(task.postedAt) > PENDING_MAX_AGE_MS) {
      rec.log.warn("saved SERP task is too old to collect, posting it again", {
        taskId: task.taskId,
        postedAt: task.postedAt,
      });
      this.tasks.delete(hash);
      return null;
    }
    rec.log.debug("collecting a SERP task posted by an earlier run", { taskId: task.taskId });
    return task;
  }

  /**
   * Many organic SERPs through the standard queue: up to 100 tasks per task_post, then
   * tasks_ready + task_get for each. Shares the cache with serpOrganic (same request hash), so
   * cached keywords cost nothing. The budget is checked before every batch post, so a run can
   * overshoot by at most one batch (100 SERPs, about $0.06). Task ids are saved at post time:
   * what a run paid for but couldn't collect (timeout, crash) is collected by the next run.
   * One failing task never takes the batch down with it.
   */
  async serpOrganicBatch(
    keywords: string[],
    market: Market,
    rec: CallRecorder,
    opts: { depth?: number; device?: "desktop" | "mobile"; chunk?: number } = {},
  ): Promise<SerpBatchResult> {
    const endpoint = SERP_TASK_ENDPOINT;
    const serps = new Map<string, SerpResult>();
    const blocked: string[] = [];
    const failed: SerpBatchResult["failed"] = [];
    type Job = {
      keyword: string;
      payload: Record<string, unknown>;
      hash: string;
      cost: number;
      errors: number;
    };
    const todo: Job[] = [];
    const pending = new Map<string, Job>();
    const where = await this.serpParams(market, rec);
    for (const keyword of [...new Set(keywords)]) {
      const payload = serpTaskPayload(keyword, where, opts);
      const hash = requestHash(endpoint, payload);
      const hit = this.hit(endpoint, hash, rec);
      if (hit) {
        serps.set(keyword, parseSerp(keyword, hit.result));
        continue;
      }
      // Already paid for by an earlier run: collect it, even with paid SERP calls off.
      const saved = this.savedTask(hash, rec);
      if (saved) {
        pending.set(saved.taskId, { keyword, payload, hash, cost: saved.costUsd, errors: 0 });
      } else if (!this.opts.allowLiveSerp) {
        blocked.push(keyword);
      } else {
        todo.push({ keyword, payload, hash, cost: 0, errors: 0 });
      }
    }
    if (blocked.length) {
      rec.log.warn("SERPs not cached and paid SERP calls are off", { count: blocked.length });
    }

    // Out of budget: stop posting, still collect what is already paid for, then report it.
    let overBudget: BudgetExceededError | null = null;
    const chunk = Math.min(opts.chunk ?? 100, 100);
    for (let i = 0; i < todo.length; i += chunk) {
      overBudget = this.overBudget(`${todo.length - i} SERPs not posted`);
      if (overBudget) break;
      const part = todo.slice(i, i + chunk);
      const res = await this.request(
        "POST",
        endpoint,
        part.map((j) => ({ ...j.payload, tag: j.hash })),
        rec,
        `batch-${part[0]?.hash ?? ""}`,
        { batch: true },
      );
      for (const [n, task] of (res.tasks ?? []).entries()) {
        const job = part.find((j) => j.hash === task.data?.tag) ?? part[n];
        if (!job) continue;
        if (!task.id || task.status_code !== 20100) {
          failed.push({
            keyword: job.keyword,
            error: `${task.status_code} ${task.status_message}`,
          });
          continue;
        }
        job.cost = task.cost ?? 0;
        this.spend(endpoint, job.hash, job.cost);
        this.tasks.set(job.hash, {
          taskId: task.id,
          endpoint,
          payload: job.payload,
          postedAt: new Date().toISOString(),
          costUsd: job.cost,
        });
        pending.set(task.id, job);
      }
    }

    const collect = async (id: string, job: Job): Promise<void> => {
      let got: DfsResponse;
      try {
        got = await this.request(
          "GET",
          `serp/google/organic/task_get/advanced/${id}`,
          undefined,
          rec,
          job.hash,
          { allowPending: true },
        );
      } catch (err) {
        const message = (err as Error).message;
        if (err instanceof DataforseoError && !err.retryable) {
          // The task failed for good or no longer exists: a later run posts it fresh.
          pending.delete(id);
          this.tasks.delete(job.hash);
          failed.push({ keyword: job.keyword, error: message });
          return;
        }
        job.errors++;
        rec.log.warn("SERP task_get failed", { keyword: job.keyword, tries: job.errors, message });
        if (job.errors >= COLLECT_MAX_ERRORS) {
          pending.delete(id);
          failed.push({ keyword: job.keyword, error: `${message}; ${KEPT}` });
        }
        return;
      }
      const task = got.tasks?.[0];
      if (!task || TASK_PENDING.has(task.status_code)) return; // not ready yet
      pending.delete(id);
      const result = task.result?.[0] ?? null;
      this.cache.set(job.hash, {
        endpoint,
        payload: job.payload,
        fetchedAt: new Date().toISOString(),
        costUsd: job.cost,
        result,
      });
      this.tasks.delete(job.hash);
      serps.set(job.keyword, parseSerp(job.keyword, result));
    };
    const collectAll = async (ids: string[]) => {
      for (let i = 0; i < ids.length; i += 8) {
        await Promise.all(
          ids.slice(i, i + 8).flatMap((id) => {
            const job = pending.get(id);
            return job ? [collect(id, job)] : [];
          }),
        );
      }
    };

    const interval = this.opts.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + (this.opts.pollTimeoutMs ?? 30 * 60_000);
    while (pending.size) {
      let listed: string[] = [];
      try {
        const ready = await this.request(
          "GET",
          "serp/google/organic/tasks_ready",
          undefined,
          rec,
          "tasks_ready",
          { batch: true },
        );
        listed = (ready.tasks ?? [])
          .flatMap((t) => (Array.isArray(t.result) ? (t.result as { id?: string }[]) : []))
          .map((r) => r.id)
          .filter((id): id is string => !!id && pending.has(id));
      } catch (err) {
        // The ready list is a shortcut; the direct checks below still find finished tasks.
        rec.log.warn("tasks_ready failed, checking tasks directly", {
          message: (err as Error).message,
        });
      }
      if (listed.length) {
        await collectAll(listed);
        continue;
      }
      // tasks_ready can lag; check the oldest few directly so nothing waits forever.
      await collectAll([...pending.keys()].slice(0, 16));
      if (!pending.size) break;
      if (Date.now() > deadline) {
        for (const job of pending.values()) {
          failed.push({ keyword: job.keyword, error: `task not ready before timeout; ${KEPT}` });
        }
        rec.log.warn("SERP tasks not ready before timeout", { count: pending.size });
        pending.clear();
        break;
      }
      rec.log.debug("serp batch pending", { pending: pending.size });
      await this.sleep(interval);
    }
    if (failed.length) {
      rec.log.warn("SERPs failed", { count: failed.length, failed: failed.slice(0, 10) });
    }
    if (overBudget) throw overBudget;
    return { serps, blocked, failed };
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
          `task not ready before timeout; ${KEPT}`,
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
    const hash = requestHash(endpoint, payload);
    const hit = this.hit(endpoint, hash, rec);
    if (hit) return hit.result;
    const fresh = await this.paid(endpoint, hash, `not calling ${endpoint}`, async () => {
      const res = await this.request("POST", endpoint, [payload], rec, hash);
      const task = res.tasks?.[0];
      const costUsd = task?.cost ?? res.cost ?? 0;
      return { value: { result: task?.result?.[0] ?? null, costUsd }, costUsd };
    });
    this.cache.set(hash, {
      endpoint,
      payload,
      fetchedAt: new Date().toISOString(),
      costUsd: fresh.costUsd,
      result: fresh.result,
    });
    return fresh.result;
  }

  /**
   * One paid call, with the budget check in front. Calls can run in parallel, so each one
   * reserves its expected price while it is out; otherwise every call in a parallel burst would
   * pass the check on the same "spent so far". The first paid call to an endpoint runs alone,
   * because its price is only known once it is back.
   */
  private async paid<T>(
    endpoint: string,
    hash: string,
    what: string,
    call: () => Promise<{ value: T; costUsd: number }>,
  ): Promise<T> {
    for (let probe = this.pricing.get(endpoint); probe; probe = this.pricing.get(endpoint)) {
      await probe;
    }
    const over = this.overBudget(what);
    if (over) throw over;
    const estimate = this.price.get(endpoint);
    let priced = () => {};
    if (estimate === undefined) {
      this.pricing.set(
        endpoint,
        new Promise<void>((resolve) => {
          priced = resolve;
        }),
      );
    }
    this.reserved += estimate ?? 0;
    try {
      const { value, costUsd } = await call();
      this.price.set(endpoint, Math.max(costUsd, estimate ?? 0));
      this.spend(endpoint, hash, costUsd);
      return value;
    } finally {
      this.reserved -= estimate ?? 0;
      if (estimate === undefined) {
        this.pricing.delete(endpoint);
        priced();
      }
    }
  }

  private spend(endpoint: string, hash: string, costUsd: number): void {
    this.spent += costUsd;
    this.ledger.add({ endpoint, requestHash: hash, costUsd });
  }

  /** The error to raise when the run budget or the monthly budget is used up, else null. */
  private overBudget(what: string): BudgetExceededError | null {
    const { budgetUsd, monthlyBudgetUsd } = this.opts;
    if (this.spent + this.reserved >= budgetUsd) {
      return new BudgetExceededError(
        `DataforSEO budget of $${budgetUsd} reached ($${this.spentUsd} spent); ${what}`,
      );
    }
    if (monthlyBudgetUsd !== undefined) {
      const month = this.ledger.spentThisMonth();
      if (month + this.reserved >= monthlyBudgetUsd) {
        return new BudgetExceededError(
          `DataforSEO monthly budget of $${monthlyBudgetUsd} reached ($${month} spent in ${this.ledger.currentMonth()}); ${what}`,
        );
      }
    }
    return null;
  }

  /** A cache hit costs nothing and is still logged. */
  private hit(endpoint: string, hash: string, rec: CallRecorder): CacheEntry | null {
    const hit = this.cache.get(hash);
    if (!hit) return null;
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
    return hit;
  }

  /** One HTTP call with retries on network errors, 429, 5xx and DataforSEO 5xxxx codes. Each attempt is logged. */
  private async request(
    method: "GET" | "POST",
    endpoint: string,
    body: unknown,
    rec: CallRecorder,
    hash: string,
    opts: { allowPending?: boolean; batch?: boolean } = {},
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
        // A batch call is ok when the request is; each task's own status is checked by the caller.
        const ok =
          json.status_code === 20000 && (opts.batch || code === 20000 || code === 20100 || pending);
        rec.recordApiCall({
          service: SERVICE,
          endpoint,
          requestHash: hash,
          cache: "miss",
          costUsd:
            method === "POST"
              ? opts.batch
                ? (json.cost ?? 0)
                : (task?.cost ?? json.cost ?? 0)
              : 0,
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
