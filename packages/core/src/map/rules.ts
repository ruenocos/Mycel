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
 * The first plan: what an owner can review and act on. Conflicts come first (up to `max`), then
 * pages to improve and new pages by value until `size`. Everything else is "later".
 */
export const PLAN = { size: 30, max: 40 } as const;

/** Longest proposed slug; it is cut at a word, never inside one. */
export const MAX_SLUG = 60;

/** Most hubs offered per label prompt: site hubs, then core, then demand. */
export const MAX_HUBS = 120;

/** Question words per market language: a question is never a service page by itself. */
export const QUESTION_WORDS: Record<string, Set<string>> = {
  nl: new Set(["wat", "hoe", "waarom", "wanneer", "welke", "wie", "waar", "hoeveel", "kan", "mag"]),
  en: new Set(["what", "how", "why", "when", "which", "who", "where", "can", "does", "is"]),
};
