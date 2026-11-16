import { FileCache, requestHash } from "../dataforseo/cache.ts";
import { withUserAgent } from "../http.ts";
import type { CallRecorder } from "../recorder.ts";

/**
 * Read-only Wikidata reader (issue #63, Koray steps 3 and 7): is the central entity a known
 * thing, and what does Wikidata say about the domain's terms (description, other names, broader
 * terms, parts). Free and cached; one request at a time with a pause, as Wikimedia asks of bots.
 */

const SERVICE = "wikidata";
const API = "https://www.wikidata.org/w/api.php";

export interface WikidataHit {
  id: string;
  label: string;
  description?: string;
  /** The alias the search matched on, when it wasn't the label. */
  matched?: string;
}

export interface WikidataEntity {
  id: string;
  label?: string;
  description?: string;
  /** Other names in the asked language. */
  aliases: string[];
  /** instance of (P31) and subclass of (P279): broader terms. */
  broader: string[];
  /** has part (P527). */
  parts: string[];
  /** part of (P361). */
  partOf: string[];
  /** Wikipedia article in the asked language, else English. */
  wikipedia?: string;
}

export interface WikidataOptions {
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Pause between requests (default 1 s). */
  pauseMs?: number;
  /** Tries per request when Wikidata says slow down (429, 503 or maxlag); default 4. */
  attempts?: number;
}

/** How long to wait before the next try: the server's Retry-After, else 5, 10, 20 s. Max 60 s. */
export function backoffMs(retryAfter: string | null, attempt: number): number {
  const s = Number(retryAfter);
  const ms = Number.isFinite(s) && s > 0 ? s * 1000 : 5000 * 2 ** attempt;
  return Math.min(ms, 60_000);
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" ? (v as Raw) : {});
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export class WikidataError extends Error {
  override name = "WikidataError";
}

/** The ids a claim points to (P31, P279, ...). */
function claimIds(claims: Raw, prop: string): string[] {
  return arr(claims[prop])
    .map((c) => str(obj(obj(obj(c.mainsnak).datavalue).value).id))
    .filter((x): x is string => !!x);
}

const text = (m: Raw, language: string) => str(obj(m[language]).value) ?? str(obj(m.en).value);

/** wbgetentities → entities with relation ids (labels for those come in a second call). */
export function parseEntities(
  body: unknown,
  language: string,
): (Omit<WikidataEntity, "broader" | "parts" | "partOf"> & {
  broaderIds: string[];
  partIds: string[];
  partOfIds: string[];
})[] {
  return Object.values(obj(obj(body).entities))
    .map((e) => obj(e))
    .filter((e) => str(e.id) && e.missing === undefined)
    .map((e) => {
      const claims = obj(e.claims);
      const links = obj(e.sitelinks);
      const wiki = obj(links[`${language}wiki`]).title
        ? obj(links[`${language}wiki`])
        : obj(links.enwiki);
      const site = obj(links[`${language}wiki`]).title ? language : "en";
      const title = str(wiki.title);
      const label = text(obj(e.labels), language);
      const description = text(obj(e.descriptions), language);
      return {
        id: e.id as string,
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
        aliases: arr(obj(e.aliases)[language])
          .map((a) => str(a.value))
          .filter((x): x is string => !!x),
        broaderIds: [...claimIds(claims, "P279"), ...claimIds(claims, "P31")],
        partIds: claimIds(claims, "P527"),
        partOfIds: claimIds(claims, "P361"),
        ...(title
          ? {
              wikipedia: `https://${site}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
            }
          : {}),
      };
    });
}

export class WikidataClient {
  private readonly cache: FileCache | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private calls = 0;

  constructor(private readonly opts: WikidataOptions = {}) {
    this.cache = opts.cacheDir ? new FileCache(opts.cacheDir) : undefined;
    this.fetchImpl = withUserAgent(opts.fetchImpl ?? fetch);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Items whose label or other name matches the term, in the market language. */
  async search(
    term: string,
    language: string,
    rec: CallRecorder,
    limit = 7,
  ): Promise<WikidataHit[]> {
    const body = await this.get(
      {
        action: "wbsearchentities",
        search: term,
        language,
        uselang: language,
        type: "item",
        limit: String(limit),
      },
      rec,
    );
    return arr(obj(body).search).map((h) => {
      const label = str(h.label) ?? str(h.id) ?? "";
      const matched = str(obj(h.match).text);
      const description = str(h.description);
      return {
        id: str(h.id) ?? "",
        label,
        ...(description ? { description } : {}),
        ...(matched && matched.toLowerCase() !== label.toLowerCase() ? { matched } : {}),
      };
    });
  }

  /** Full entities with their broader terms, parts and wholes named in the market language. */
  async entities(ids: string[], language: string, rec: CallRecorder): Promise<WikidataEntity[]> {
    const raw = [];
    for (let i = 0; i < ids.length; i += 50) {
      const body = await this.get(
        {
          action: "wbgetentities",
          ids: ids.slice(i, i + 50).join("|"),
          props: "labels|descriptions|aliases|claims|sitelinks",
          languages: `${language}|en`,
          sitefilter: `${language}wiki|enwiki`,
        },
        rec,
      );
      raw.push(...parseEntities(body, language));
    }
    const related = [
      ...new Set(raw.flatMap((e) => [...e.broaderIds, ...e.partIds, ...e.partOfIds])),
    ];
    const names = await this.labels(related, language, rec);
    const name = (ids: string[]) => ids.map((id) => names.get(id)).filter((x): x is string => !!x);
    return raw.map(({ broaderIds, partIds, partOfIds, ...e }) => ({
      ...e,
      broader: name(broaderIds),
      parts: name(partIds),
      partOf: name(partOfIds),
    }));
  }

  private async labels(ids: string[], language: string, rec: CallRecorder) {
    const out = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 50) {
      const body = await this.get(
        {
          action: "wbgetentities",
          ids: ids.slice(i, i + 50).join("|"),
          props: "labels",
          languages: `${language}|en`,
        },
        rec,
      );
      for (const e of Object.values(obj(obj(body).entities)).map(obj)) {
        const label = text(obj(e.labels), language);
        if (str(e.id) && label) out.set(e.id as string, label);
      }
    }
    return out;
  }

  private async get(params: Record<string, string>, rec: CallRecorder): Promise<unknown> {
    const query = new URLSearchParams({ ...params, format: "json", maxlag: "5" });
    const url = `${API}?${query}`;
    const hash = requestHash(`${SERVICE}:${url}`, {});
    const endpoint = params.action ?? "api";
    const startedAt = new Date().toISOString();
    const cached = this.cache?.get<unknown>(hash)?.result;
    if (cached !== undefined) {
      rec.recordApiCall({
        service: SERVICE,
        endpoint,
        requestHash: hash,
        cache: "hit",
        costUsd: 0,
        latencyMs: 0,
        status: 200,
        startedAt,
      });
      return cached;
    }
    if (this.calls++ > 0) await this.sleep(this.opts.pauseMs ?? 1000);
    const t0 = Date.now();
    let status: number | "error" = "error";
    try {
      const attempts = this.opts.attempts ?? 4;
      let json: Raw = {};
      for (let attempt = 0; ; attempt++) {
        const res = await this.fetchImpl(url, { headers: { Accept: "application/json" } });
        status = res.status;
        const body = await res.text();
        const slowDown = res.status === 429 || res.status === 503;
        if (!res.ok && !slowDown)
          throw new WikidataError(`${endpoint}: HTTP ${res.status} ${body.slice(0, 120)}`);
        json = slowDown ? {} : (JSON.parse(body) as Raw);
        const lag = str(obj(json.error).code) === "maxlag";
        if (!slowDown && !lag) break;
        // Wikimedia asks bots to wait and try again, not to give up or push on.
        if (attempt + 1 >= attempts) {
          throw new WikidataError(
            `${endpoint}: ${slowDown ? `HTTP ${res.status}` : "maxlag"} after ${attempts} tries`,
          );
        }
        await this.sleep(backoffMs(res.headers.get("retry-after"), attempt));
      }
      if (json.error)
        throw new WikidataError(`${endpoint}: ${str(obj(json.error).info) ?? "error"}`);
      rec.recordApiCall({
        service: SERVICE,
        endpoint,
        requestHash: hash,
        cache: this.cache ? "miss" : "bypass",
        costUsd: 0,
        latencyMs: Date.now() - t0,
        status,
        startedAt,
      });
      this.cache?.set(hash, {
        endpoint: url,
        payload: {},
        fetchedAt: startedAt,
        costUsd: 0,
        result: json,
      });
      return json;
    } catch (err) {
      const e = err as Error;
      rec.recordApiCall({
        service: SERVICE,
        endpoint,
        requestHash: hash,
        cache: "miss",
        costUsd: 0,
        latencyMs: Date.now() - t0,
        status,
        error: { name: e.name, message: e.message },
        startedAt,
      });
      throw err instanceof WikidataError ? err : new WikidataError(`${endpoint}: ${e.message}`);
    }
  }
}
