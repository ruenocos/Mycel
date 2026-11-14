import type { Market } from "@mycel/schema";

/** DataforSEO location codes per country. Extend when a client needs another market. */
const COUNTRY_CODES: Record<string, number> = {
  NL: 2528,
  BE: 2056,
  DE: 2276,
  FR: 2250,
  GB: 2826,
  US: 2840,
};

export interface MarketParams {
  location_code: number;
  language_code: string;
}

/**
 * Market → DataforSEO params at country level. Labs data (keyword ideas, ranked keywords) only
 * exists per country. SERPs for a market with a city are fetched at city level: see `findCity`.
 */
export function marketParams(market: Market): MarketParams {
  const code = COUNTRY_CODES[market.country];
  if (code === undefined) {
    throw new Error(
      `no DataforSEO location code for country ${market.country}; add it to COUNTRY_CODES`,
    );
  }
  return { location_code: code, language_code: market.language };
}

/** One row of DataforSEO's SERP location list (GET serp/google/locations/<country>). */
export interface DfsLocation {
  location_code: number;
  /** City first, then the regions around it: "Utrecht,Utrecht,Utrecht,Netherlands". */
  location_name: string;
  country_iso_code?: string;
  location_type?: string;
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Find the market's city in DataforSEO's location list, so a local business gets the SERP its
 * customers see. The city may carry a region to tell namesakes apart ("Elst, Gelderland").
 * Cities win over municipalities. More than one match is no match: the caller falls back to
 * the country and says so, instead of guessing which city was meant.
 */
export function findCity(
  locations: DfsLocation[],
  market: Market,
): { match?: DfsLocation; candidates: DfsLocation[] } {
  const [city, ...regions] = (market.city ?? "").split(",").map(fold).filter(Boolean);
  if (!city) return { candidates: [] };
  const named = locations.filter((l) => {
    if (l.country_iso_code && l.country_iso_code !== market.country) return false;
    const [first, ...rest] = l.location_name.split(",").map(fold);
    return first === city && regions.every((r) => rest.includes(r));
  });
  for (const type of ["City", "Municipality"]) {
    const candidates = named.filter((l) => l.location_type === type);
    const [match] = candidates;
    if (candidates.length === 1 && match) return { match, candidates };
    if (candidates.length > 1) return { candidates };
  }
  return { candidates: [] };
}
