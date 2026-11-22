import type { ReadingLevel } from "@mycel/schema";

/** Tunable numbers for page briefs (ADR 0020). Generic: nothing here is client-specific. */

export const BRIEF = {
  /** Words for a page by its main intent, before its sections. */
  words: {
    informational: 1200,
    commercial: 1000,
    transactional: 700,
    navigational: 400,
    local: 800,
  } as Record<string, number>,
  /** Extra words for each search answered as a section on the page (QDP section). */
  wordsPerSection: 150,
  maxWords: 2500,
  /** The main search about once per this many words, and at least `minKeywordUses` times. */
  wordsPerKeywordUse: 300,
  minKeywordUses: 2,
  readingLevel: "B1" as ReadingLevel,
  /** Facts offered to the model, questions offered and kept, competing results shown. */
  maxEvidence: 25,
  maxQuestionCandidates: 25,
  maxQuestions: 8,
  maxResults: 5,
  /** Points per heading, angles to avoid. */
  maxPoints: 6,
  maxAvoid: 5,
  /**
   * What the dry run counts for one answer: a full brief as JSON is about 8,000 characters. Only
   * an estimate; the run logs the real tokens (ADR 0009).
   */
  estimatedOutputTokens: 2000,
};

/** Labels for facts built from profile fields, in the market language; English as fallback. */
export const FACT_LABELS: Record<
  string,
  { serves: string; location: string; price: string; range: string }
> = {
  nl: {
    serves: "Werkgebied",
    location: "Locatie",
    price: "Prijs",
    range: "Aanbod",
  },
  en: {
    serves: "Area served",
    location: "Location",
    price: "Price",
    range: "Range",
  },
};
