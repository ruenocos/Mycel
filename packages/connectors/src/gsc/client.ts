import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { FileCache, requestHash } from "../dataforseo/cache.ts";
import type { CallRecorder } from "../recorder.ts";

/** Google Search Console, read-only, via a service account (issue #14). */

export class GscError extends Error {
  override name = "GscError";
  constructor(
    message: string,
    readonly endpoint: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export type GscDimension = "query" | "page" | "country" | "device" | "date" | "searchAppearance";

export interface GscQuery {
  /** YYYY-MM-DD, inclusive. */
  startDate: string;
  endDate: string;
  dimensions: GscDimension[];
  type?: "web" | "image" | "video" | "news" | "discover" | "googleNews";
  dataState?: "final" | "all";
  /** Stop after this many rows in total. Default: everything GSC returns. */
  maxRows?: number;
}

export interface GscRow {
  keys: Partial<Record<GscDimension, string>>;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscOptions {
  credentials: ServiceAccount;
  /** "sc-domain:example.com" or "https://example.com/". */
  property: string;
  /** Store responses by request hash, so a re-run reads the same data. Client data: keep out of git. */
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  now?: () => number;
}

const SERVICE = "gsc";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API = "https://www.googleapis.com/webmasters/v3";
const PAGE_SIZE = 25_000;

export function loadServiceAccount(path: string): ServiceAccount {
  let json: Partial<ServiceAccount>;
  try {
    json = JSON.parse(readFileSync(path, "utf8")) as Partial<ServiceAccount>;
  } catch (err) {
    throw new Error(`could not read GSC service account at ${path}: ${(err as Error).message}`);
  }
  if (!json.client_email || !json.private_key) {
    throw new Error(`${path} is not a service account key (no client_email or private_key)`);
  }
  return {
    client_email: json.client_email,
    private_key: json.private_key,
    ...(json.token_uri ? { token_uri: json.token_uri } : {}),
  };
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export class GscClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly cache: FileCache | null;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly opts: GscOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.cache = opts.cacheDir ? new FileCache(opts.cacheDir) : null;
  }

  get serviceAccountEmail(): string {
    return this.opts.credentials.client_email;
  }

  /** Signed JWT exchanged for an access token (RFC 7523). The key never leaves this process. */
  private async accessToken(rec: CallRecorder): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    const tokenUri = this.opts.credentials.token_uri ?? "https://oauth2.googleapis.com/token";
    const iat = Math.floor(this.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({
        iss: this.opts.credentials.client_email,
        scope: SCOPE,
        aud: tokenUri,
        iat,
        exp: iat + 3600,
      }),
    );
    const signature = createSign("RSA-SHA256")
      .update(`${header}.${claims}`)
      .sign(this.opts.credentials.private_key, "base64url");
    const json = await this.send(
      "oauth/token",
      tokenUri,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: `${header}.${claims}.${signature}`,
        }).toString(),
      },
      rec,
      "-",
    );
    const value = (json as { access_token?: string }).access_token;
    const ttl = (json as { expires_in?: number }).expires_in ?? 3600;
    if (!value) throw new GscError("token response had no access_token", "oauth/token", 200, false);
    this.token = { value, expiresAt: this.now() + ttl * 1000 };
    return value;
  }

  /** Properties this service account can read. Used by `mycel gsc check`. */
  async listSites(rec: CallRecorder): Promise<{ siteUrl: string; permissionLevel: string }[]> {
    const token = await this.accessToken(rec);
    const json = (await this.send(
      "sites",
      `${API}/sites`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      rec,
      "-",
    )) as { siteEntry?: { siteUrl: string; permissionLevel: string }[] };
    return json.siteEntry ?? [];
  }

  /** Search Analytics rows, paged until GSC runs out (or maxRows). Pages are cached by request hash. */
  async searchAnalytics(q: GscQuery, rec: CallRecorder): Promise<GscRow[]> {
    const endpoint = "searchAnalytics/query";
    const url = `${API}/sites/${encodeURIComponent(this.opts.property)}/${endpoint}`;
    const rows: GscRow[] = [];
    const max = q.maxRows ?? Number.POSITIVE_INFINITY;
    for (let startRow = 0; rows.length < max; startRow += PAGE_SIZE) {
      const rowLimit = Math.min(PAGE_SIZE, max - rows.length);
      const body = {
        startDate: q.startDate,
        endDate: q.endDate,
        dimensions: q.dimensions,
        type: q.type ?? "web",
        dataState: q.dataState ?? "final",
        rowLimit,
        startRow,
      };
      const hash = requestHash(`${SERVICE}/${this.opts.property}/${endpoint}`, body);
      const page = await this.cachedPage(hash, endpoint, body, rec, async () => {
        const token = await this.accessToken(rec);
        return this.send(
          endpoint,
          url,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
          rec,
          hash,
        );
      });
      const got = ((page as { rows?: RawRow[] }).rows ?? []).map((r) => toRow(r, q.dimensions));
      rows.push(...got);
      if (got.length < rowLimit) break;
    }
    return rows;
  }

  private async cachedPage(
    hash: string,
    endpoint: string,
    payload: unknown,
    rec: CallRecorder,
    fetcher: () => Promise<unknown>,
  ): Promise<unknown> {
    const hit = this.cache?.get(hash);
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
    const result = await fetcher();
    this.cache?.set(hash, {
      endpoint,
      payload,
      fetchedAt: new Date().toISOString(),
      costUsd: 0,
      result,
    });
    return result;
  }

  /** One HTTP call with retries on network errors, 429 and 5xx. Every attempt is logged (ADR 0009). */
  private async send(
    endpoint: string,
    url: string,
    init: RequestInit,
    rec: CallRecorder,
    hash: string,
  ): Promise<unknown> {
    const maxRetries = this.opts.maxRetries ?? 3;
    for (let attempt = 1; ; attempt++) {
      const startedAt = new Date().toISOString();
      const t0 = performance.now();
      let status: number | "error" = "error";
      try {
        const res = await this.fetchImpl(url, init).catch((err: Error) => {
          throw new GscError(`network error: ${err.message}`, endpoint, 0, true);
        });
        status = res.status;
        const text = await res.text();
        if (!res.ok) {
          let msg = text.slice(0, 300);
          try {
            const j = JSON.parse(text) as {
              error?: { message?: string } | string;
              error_description?: string;
            };
            msg =
              j.error_description ??
              (typeof j.error === "string" ? j.error : j.error?.message) ??
              msg;
          } catch {
            // not JSON: keep the raw text, already in msg
          }
          throw new GscError(
            `HTTP ${res.status}: ${msg}`,
            endpoint,
            res.status,
            res.status === 429 || res.status >= 500,
          );
        }
        rec.recordApiCall({
          service: SERVICE,
          endpoint,
          requestHash: hash,
          cache: this.cache && hash !== "-" ? "miss" : "bypass",
          costUsd: 0,
          latencyMs: Math.round(performance.now() - t0),
          status: res.status,
          startedAt,
        });
        return JSON.parse(text) as unknown;
      } catch (err) {
        const e = err as Error;
        rec.recordApiCall({
          service: SERVICE,
          endpoint,
          requestHash: hash,
          cache: this.cache && hash !== "-" ? "miss" : "bypass",
          costUsd: 0,
          latencyMs: Math.round(performance.now() - t0),
          status: typeof status === "number" && status >= 400 ? status : "error",
          error: { name: e.name, message: e.message },
          startedAt,
        });
        const retryable = err instanceof GscError && err.retryable;
        if (!retryable || attempt > maxRetries) throw err;
        rec.log.warn("GSC call failed, retrying", { endpoint, attempt, error: e.message });
        await this.sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }
}

interface RawRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

function toRow(r: RawRow, dims: GscDimension[]): GscRow {
  const keys: GscRow["keys"] = {};
  for (const [i, d] of dims.entries()) {
    const k = r.keys?.[i];
    if (k !== undefined) keys[d] = k;
  }
  return {
    keys,
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  };
}
