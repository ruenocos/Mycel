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
 * Market → DataforSEO params. Country level for now; city-level targeting for local
 * clients (Praktijk Beweegruimte) needs DataforSEO's location list and lands with step 7-8 (#16).
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
