/** Tunable numbers for the map signals (issue #63). Generic: nothing here is client-specific. */

export const TRENDS = {
  /** At least this change against a year earlier is rising (or, negative, falling). */
  rising: 0.3,
  falling: -0.3,
  /** Average monthly searches below this say too little for a trend. */
  minMonthly: 10,
  /** A year is seasonal when its best month reaches this times the median month. */
  seasonalRatio: 2,
  /** A month is a peak month at this times the median month. */
  peakRatio: 1.5,
  /** Publish this many months before the peak starts. */
  leadMonths: 2,
  /** Google Trends explore calls: the central entity and the top offerings. */
  maxTopics: 5,
  maxIdeas: 25,
};

export const COMPETITORS = {
  /** Competitor sites read per run. */
  max: 5,
  /** Only a candidate seen in this many seed results counts when the owner confirmed none. */
  minSerpAppearances: 3,
  /** One day holding more than this share of last-modified dates means the dates are generated. */
  sameDayShare: 0.5,
  /** A gap needs this many competitors and pages. */
  gapCompetitors: 2,
  gapPages: 3,
  maxGaps: 25,
  /** Folders shown per competitor. */
  sections: 8,
};

/** URLs that are no content page: lists, accounts, legal, files. Generic, any language. */
export const NON_CONTENT_URL =
  /\/(tags?|author|auteur|page|feed|cart|winkelwagen|checkout|afrekenen|account|mijn-account|login|inloggen|wp-content|wp-json|search|zoeken|privacy[^/]*|cookie[^/]*|disclaimer|terms[^/]*|algemene-voorwaarden|voorwaarden)(\/|$)|\.(pdf|jpe?g|png|gif|webp|svg|xml|zip|docx?)$|\?/i;

/** Words in URLs that name no topic. */
export const URL_NOISE = new Set([
  "blog",
  "blogs",
  "nieuws",
  "news",
  "artikel",
  "artikelen",
  "product",
  "producten",
  "products",
  "categorie",
  "category",
  "collections",
  "collection",
  "shop",
  "winkel",
  "pagina",
  "page",
  "home",
  "index",
  "html",
  "php",
  "www",
  "nl",
  "en",
  "be",
  "kennisbank",
  "over",
  "contact",
  "ons",
  "wij",
]);
