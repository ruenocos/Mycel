import { resultKey, type UrlSource } from "./url.ts";

/* Parsers from DataforSEO task results to the small shapes Mycel uses. The raw result
   stays in the cache, so a parser fix never needs a paid refetch. */

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" ? (v as Raw) : {});
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export interface OrganicResult {
  rank: number;
  title: string;
  /** Key used for SERP overlap; see url.ts. */
  key: string;
  urlSource: UrlSource;
  /** Real URL when DataforSEO resolved it, else null. */
  url: string | null;
  domain: string | null;
}

export interface SerpResult {
  keyword: string;
  organic: OrganicResult[];
  aiOverview: {
    present: boolean;
    references: {
      url: string;
      domain: string | null;
      title: string | null;
      source: string | null;
    }[];
  };
  peopleAlsoAsk: string[];
  relatedSearches: string[];
  itemTypes: string[];
  /** Organic results that only had a Google redirect URL (keys from breadcrumb or domain). */
  unresolvedUrls: number;
}

export function parseSerp(keyword: string, result: unknown): SerpResult {
  const items = arr(obj(result).items);
  const organic: OrganicResult[] = [];
  const references: SerpResult["aiOverview"]["references"] = [];
  const paa: string[] = [];
  const related: string[] = [];
  let aio = false;

  for (const item of items) {
    switch (item.type) {
      case "organic": {
        const k = resultKey({
          url: str(item.url) ?? null,
          breadcrumb: str(item.breadcrumb) ?? null,
          domain: str(item.domain) ?? null,
          website_name: str(item.website_name) ?? null,
        });
        if (!k) break;
        organic.push({
          rank: num(item.rank_group) ?? organic.length + 1,
          title: str(item.title) ?? "",
          key: k.key,
          urlSource: k.source,
          url: k.source === "url" ? (str(item.url) ?? null) : null,
          domain: str(item.website_name) ?? str(item.domain) ?? null,
        });
        break;
      }
      case "ai_overview": {
        aio = true;
        const refs = [
          ...arr(item.references),
          ...arr(item.items).flatMap((i) => arr(i.references)),
        ];
        for (const r of refs) {
          const url = str(r.url);
          if (url && !references.some((x) => x.url === url)) {
            references.push({
              url,
              domain: str(r.domain) ?? null,
              title: str(r.title) ?? null,
              source: str(r.source) ?? null,
            });
          }
        }
        break;
      }
      case "people_also_ask":
        for (const q of arr(item.items)) if (str(q.title)) paa.push(q.title as string);
        break;
      case "related_searches":
        for (const q of Array.isArray(item.items) ? item.items : []) {
          if (typeof q === "string" && q) related.push(q);
        }
        break;
    }
  }

  return {
    keyword,
    organic,
    aiOverview: { present: aio, references },
    peopleAlsoAsk: paa,
    relatedSearches: related,
    itemTypes: [...new Set(items.map((i) => String(i.type)))],
    unresolvedUrls: organic.filter((o) => o.urlSource !== "url").length,
  };
}

export interface KeywordIdea {
  keyword: string;
  volume?: number;
  cpc?: number;
  competition?: number;
  intent?: string;
  /** DataforSEO's language guess; used by the noise filter (wrong-language queries). */
  detectedLanguage?: string;
}

function idea(keyword: unknown, info: Raw, intent: Raw, props: Raw): KeywordIdea | null {
  const k = str(keyword);
  if (!k) return null;
  const out: KeywordIdea = { keyword: k };
  const volume = num(info.search_volume);
  const cpc = num(info.cpc);
  const competition = num(info.competition);
  const main = str(intent.main_intent);
  const lang = str(props.detected_language);
  if (volume !== undefined) out.volume = volume;
  if (cpc !== undefined) out.cpc = cpc;
  if (competition !== undefined) out.competition = competition;
  if (main) out.intent = main;
  if (lang) out.detectedLanguage = lang;
  return out;
}

/** related_keywords: items[].keyword_data.{keyword, keyword_info, ...} */
export function parseRelatedKeywords(result: unknown): KeywordIdea[] {
  return arr(obj(result).items)
    .map((i) => obj(i.keyword_data))
    .map((d) =>
      idea(d.keyword, obj(d.keyword_info), obj(d.search_intent_info), obj(d.keyword_properties)),
    )
    .filter((x): x is KeywordIdea => x !== null);
}

/** keyword_suggestions: items[].{keyword, keyword_info, ...} */
export function parseKeywordSuggestions(result: unknown): KeywordIdea[] {
  return arr(obj(result).items)
    .map((i) =>
      idea(i.keyword, obj(i.keyword_info), obj(i.search_intent_info), obj(i.keyword_properties)),
    )
    .filter((x): x is KeywordIdea => x !== null);
}

export interface RankedKeyword extends KeywordIdea {
  position?: number;
  url?: string;
}

/** ranked_keywords: items[].keyword_data + items[].ranked_serp_element.serp_item */
export function parseRankedKeywords(result: unknown): RankedKeyword[] {
  const out: RankedKeyword[] = [];
  for (const i of arr(obj(result).items)) {
    const d = obj(i.keyword_data);
    const base = idea(
      d.keyword,
      obj(d.keyword_info),
      obj(d.search_intent_info),
      obj(d.keyword_properties),
    );
    if (!base) continue;
    const serp = obj(obj(i.ranked_serp_element).serp_item);
    const rk: RankedKeyword = { ...base };
    const pos = num(serp.rank_group);
    const url = str(serp.url);
    if (pos !== undefined) rk.position = pos;
    if (url) rk.url = url;
    out.push(rk);
  }
  return out;
}

export interface CompetitorDomain {
  domain: string;
  /** Keywords both domains rank for. */
  intersections?: number;
  avgPosition?: number;
}

/** competitors_domain: items[].domain, intersections, avg_position. The target itself is left out. */
export function parseCompetitorDomains(result: unknown, target: string): CompetitorDomain[] {
  const self = target.replace(/^www\./, "").toLowerCase();
  const out: CompetitorDomain[] = [];
  for (const i of arr(obj(result).items)) {
    const domain = str(i.domain)
      ?.replace(/^www\./, "")
      .toLowerCase();
    if (!domain || domain === self) continue;
    const c: CompetitorDomain = { domain };
    const inter = num(i.intersections);
    const pos = num(i.avg_position);
    if (inter !== undefined) c.intersections = inter;
    if (pos !== undefined) c.avgPosition = pos;
    out.push(c);
  }
  return out;
}
