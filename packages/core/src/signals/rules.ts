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

export const GLOSSARY = {
  /** Terms kept in the glossary. */
  max: 40,
  /** A term must appear in this many kept searches (central entity and offerings always count). */
  minQueries: 3,
  /** Terms per model call when matching them to Wikidata. */
  batch: 20,
  /** Wikidata candidates shown per term. */
  candidates: 6,
  /** Terms listed on one page (lexical expansion, step 12.1). */
  perPage: 10,
};

/**
 * Words that say what someone wants to do, not what about: they make no glossary term.
 * Per market language; generic, nothing client-specific.
 */
export const MODIFIERS: Record<string, Set<string>> = {
  nl: new Set([
    ...["kopen", "koop", "bestellen", "prijs", "prijzen", "kosten", "kost", "goedkoop", "goedkope"],
    ...["beste", "top", "online", "review", "reviews", "ervaringen", "vergelijken", "vergelijking"],
    ...["tips", "tip", "soorten", "welke", "waar", "nodig", "maken", "zelf", "laten", "wat", "hoe"],
    ...["bij", "mij", "buurt", "nabij", "voor", "zonder", "met", "per", "over", "naar", "uit"],
    ...[
      "is",
      "zijn",
      "kan",
      "mag",
      "moet",
      "word",
      "wordt",
      "worden",
      "doen",
      "the",
      "nieuw",
      "nieuwe",
    ],
  ]),
  en: new Set([
    ...["buy", "order", "price", "prices", "cost", "costs", "cheap", "best", "top", "online"],
    ...["review", "reviews", "compare", "comparison", "tips", "types", "which", "where", "near"],
    ...["me", "how", "what", "why", "make", "diy", "for", "without", "with", "per", "new", "is"],
  ]),
};
