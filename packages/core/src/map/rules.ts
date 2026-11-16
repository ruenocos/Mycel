import type { SitePage } from "@mycel/schema";

/**
 * Every threshold and page-kind rule of the map step in one place, so a rule is defined once and
 * per-site-type values (webshop, local service, B2B) can later come from here.
 */

type Kind = SitePage["kind"];

/** Pages that never join the map: the homepage is the root, about and contact sit outside it. */
export const SKIP_KINDS = new Set<Kind>(["home", "about", "contact"]);
/** Page kinds that are a section of the site: what the business offers, sells or where. */
export const HUB_KINDS = new Set<Kind>(["service", "category", "location"]);
/** Kinds that mark a folder as a format (articles, products), not a topic. */
export const FORMAT_KINDS = new Set<Kind>(["blog", "guide", "product"]);
/** Article-type pages: a content folder holds these. */
export const CONTENT_KINDS = new Set<Kind>(["blog", "guide"]);
/** Kinds the model may give an untyped ("other") page while linking. */
export const READABLE_KINDS = new Set<Kind>([
  "service",
  "category",
  "location",
  "product",
  "pricing",
  "blog",
  "guide",
  "other",
]);

export const FOLD = {
  /** Up to this monthly volume a childless new page under a hub always becomes a section of it. */
  always: 10,
  /** Up to this volume an informational, cheap-click page becomes a section too. */
  informational: 20,
  /** A page whose clicks cost this much (EUR) or more keeps its own page above `always`. */
  maxCpc: 1,
} as const;

export const GROUP = {
  /** More pages than this directly under one hub get grouped into sub-hubs. */
  maxChildren: 25,
  /** Home gets grouped when it has at least this many top-level pages that aren't site hubs. */
  minLoose: 8,
  /** A group needs this many members besides its head. */
  minMembers: 3,
} as const;

/** Shape thresholds for the gate: the hub count follows the business, so it checks ratios. */
export const SHAPE = { maxChildlessShare: 0.2, maxChildren: 40, minSiteHubsKept: 0.9 } as const;

/**
 * The first plan (issue #42, step 6): about 10 steps an owner can review and start on. Conflicts
 * on money pages come first and may run up to `max`; every step is tied to a top offering or a
 * conflict. Everything else is "later".
 */
export const PLAN = { size: 10, max: 14 } as const;

/**
 * The page budget (issue #42, step 6): a year of work at one page a week. Improving and fixing
 * existing pages counts first; new pages get what is left, split over the offerings by tier.
 * About 40% of an offering's new pages are support pages that teach (learn), the rest sell.
 * Pages over budget go to the backlog (left out, "over_budget"); a close variant of the page it
 * would sit under becomes a section of it instead.
 */
export const BUDGET = {
  work: 52,
  learnShare: 0.4,
  tierWeight: { top: 3, normal: 2, side: 1, none: 1 },
} as const;

/** Value weights (value.ts): what a page is worth to the business, before volume. */
export const VALUE = {
  tier: { top: 1, normal: 0.6, side: 0.3, none: 0.4 },
  stage: { buy: 1, compare: 0.8, learn: 0.5, find: 0.3 },
  /** Click price bands in EUR: the higher, the more a visitor is worth to advertisers. */
  cpc: [
    { min: 2, weight: 1 },
    { min: 0.5, weight: 0.85 },
  ],
  cpcDefault: 0.7,
  /** An existing page already seen in Google is a quick win; any existing page beats a new one. */
  opportunity: { seen: 1.3, existing: 1.15, new: 1 },
  /**
   * Map signals (issue #63): a topic that grows is worth a bit more, one that shrinks a bit less
   * (step 14); a topic two or more competitors have a page on is proven to matter (step 11).
   * Small on purpose: the business still decides the order.
   */
  trend: { rising: 1.15, falling: 0.85, seasonal: 1, steady: 1 },
  covered: { min: 2, weight: 1.1 },
} as const;

/** Longest proposed slug; it is cut at a word, never inside one. */
export const MAX_SLUG = 60;

/** Most hubs offered per label prompt: site hubs, then core, then demand. */
export const MAX_HUBS = 120;

/** Question words per market language: a question is never a service page by itself. */
export const QUESTION_WORDS: Record<string, Set<string>> = {
  nl: new Set(["wat", "hoe", "waarom", "wanneer", "welke", "wie", "waar", "hoeveel", "kan", "mag"]),
  en: new Set(["what", "how", "why", "when", "which", "who", "where", "can", "does", "is"]),
};

/**
 * The fact check (issue #42, step 7), per market language. A name or why-text may not praise
 * without proof (superlatives pass only when a business fact says the same) or talk SEO jargon
 * to the owner. `ownPlace` finds a claim about the business's own place ("onze praktijk in X").
 */
export const CLAIMS: Record<
  string,
  { superlatives: string[]; jargon: string[]; ownPlace: RegExp; inPlace: RegExp }
> = {
  nl: {
    superlatives: [
      "beste",
      "goedkoopste",
      "snelste",
      "grootste",
      "nummer 1",
      "nr. 1",
      "marktleider",
      "de enige",
      "gegarandeerd",
      "ongeëvenaard",
      "topkwaliteit",
      "100%",
    ],
    jargon: [
      "serp",
      "cluster",
      "hub",
      "core",
      "outer",
      "qdp",
      "intent",
      "entity",
      "topical",
      "longtail",
      "long tail",
      "kernpagina",
      "zoekintentie",
      "koopintentie",
      "informationeel",
      "transactioneel",
      "navigationeel",
    ],
    ownPlace:
      /\b(?:onze|ons|jouw|uw)\s+(?:locatie|vestiging|praktijk|winkel|showroom|kantoor|werkplaats)\s+(?:in|aan|op|bij)\s+(\p{Lu}[\p{L}'-]*(?:\s+\p{Lu}[\p{L}'-]*)*)/gu,
    inPlace: /\b(?:in|rond|bij|nabij|omgeving)\s+(\p{Lu}[\p{L}'-]*(?:\s+\p{Lu}[\p{L}'-]*)*)/gu,
  },
  en: {
    superlatives: [
      "best",
      "cheapest",
      "fastest",
      "biggest",
      "number 1",
      "no. 1",
      "market leader",
      "the only",
      "guaranteed",
      "unmatched",
      "100%",
    ],
    jargon: [
      "serp",
      "cluster",
      "hub",
      "core page",
      "outer",
      "qdp",
      "search intent",
      "entity",
      "topical",
      "long tail",
      "longtail",
    ],
    ownPlace:
      /\b(?:our|your)\s+(?:location|branch|practice|shop|store|showroom|office)\s+(?:in|at|on)\s+(\p{Lu}[\p{L}'-]*(?:\s+\p{Lu}[\p{L}'-]*)*)/gu,
    inPlace: /\b(?:in|around|near)\s+(\p{Lu}[\p{L}'-]*(?:\s+\p{Lu}[\p{L}'-]*)*)/gu,
  },
};
