import { z } from "zod";
import { BusinessProfile } from "./business.ts";
import { Market } from "./context.ts";
import { LinkOut, PageIntent } from "./map.ts";

/**
 * A page brief (ADR 0020): what a writer needs to write one page of the map, made from the
 * research the map stands on and the confirmed business profile. One file per map page,
 * `briefs/<node id>.json` next to the map.
 *
 * Data first: the questions, the links, the competing results, the targets and every fact come
 * from the data; the model writes the message, the reader, the angle and the outline around
 * them and picks which facts each part uses. It never adds a fact: evidence only comes from the
 * business profile or a cited page, and a person ticks each one off.
 *
 * Field names are English; every text a writer reads is in the market language (ADR 0013).
 * Searches, questions and result titles stay as they were found.
 */

/**
 * The version of this file. 1 was the plain-text brief of the writing test (issue #12); 2 is
 * this structured brief. A reader checks it before it trusts the rest.
 */
export const BRIEF_VERSION = 2;

/** Where a fact comes from: a page anyone can open, or a field of the confirmed business profile. */
export const EvidenceSource = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("url"),
    url: z.url(),
    /** The page's title, when known. */
    title: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("business"),
    /**
     * The field in business.json, as a path: "facts.0", "differentiators.1",
     * "offerings.<id>.proofPoints.0", "offerings.<id>.priceRange", "places.serves".
     */
    ref: z.string().min(1),
  }),
]);
export type EvidenceSource = z.infer<typeof EvidenceSource>;

/** Has a person checked the fact against its source. Mycel always writes "unchecked". */
export const EvidenceCheck = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unchecked") }),
  z.object({
    state: z.literal("checked"),
    by: z.string().min(1),
    at: z.iso.datetime(),
  }),
]);
export type EvidenceCheck = z.infer<typeof EvidenceCheck>;

const EvidenceId = z.string().regex(/^e\d+$/, "an evidence id: e1, e2, ...");

/** One fact the page may state, with its source. Quoted as the source has it, never translated. */
export const BriefEvidence = z.object({
  id: EvidenceId,
  fact: z.string().min(1),
  source: EvidenceSource,
  check: EvidenceCheck.default({ state: "unchecked" }),
});
export type BriefEvidence = z.infer<typeof BriefEvidence>;

/** How a part of the page is written. */
export const SectionForm = z.enum([
  "prose",
  "bullets",
  "numbered",
  "steps",
  "table",
  "comparison",
  "callout",
  "faq",
]);
export type SectionForm = z.infer<typeof SectionForm>;

/** One heading of the outline, with what the part under it does. */
export const BriefHeading = z.object({
  level: z.enum(["h1", "h2", "h3"]),
  heading: z.string().min(1),
  /** What this part does for the reader, in one sentence. */
  purpose: z.string().min(1),
  form: SectionForm,
  /** What the part says, a few words each. */
  points: z.array(z.string().min(1)).default([]),
  /** The evidence it uses, by id. */
  evidence: z.array(EvidenceId).default([]),
  /** Words for the part under this heading (the intro under the H1 included). */
  words: z.number().int().nonnegative(),
});
export type BriefHeading = z.infer<typeof BriefHeading>;

/** Where a question comes from: the results page, a search in the research, or a competitor gap. */
export const QuestionSource = z.enum(["people_also_ask", "related_search", "search", "gap"]);
export type QuestionSource = z.infer<typeof QuestionSource>;

export const BriefQuestion = z.object({
  /** As it was found, untranslated. */
  question: z.string().min(1),
  from: QuestionSource,
});
export type BriefQuestion = z.infer<typeof BriefQuestion>;

/** An internal link to make: from this page to another page of the map, or to it from one. */
export const BriefLink = z.object({
  direction: z.enum(["to", "from"]),
  /** The other page's map node. */
  nodeId: z.string().min(1),
  /** The other page's URL: where it lives now, else where the map plans it. */
  url: z.string().min(1),
  /** The other page's name. */
  name: z.string().min(1),
  /** The link's kind in the map. */
  type: LinkOut.shape.type,
  /** The words to link: for "to" they name the other page, for "from" this one. */
  anchor: z.string().min(1),
});
export type BriefLink = z.infer<typeof BriefLink>;

/** One of the current top results the page competes with. */
export const BriefResult = z.object({
  rank: z.number().int().positive(),
  title: z.string(),
  url: z.string().nullable(),
  domain: z.string().nullable(),
});
export type BriefResult = z.infer<typeof BriefResult>;

/** CEFR level the text is written at. B1 reaches most readers (Dutch "taalniveau B1"). */
export const ReadingLevel = z.enum(["A2", "B1", "B2", "C1"]);
export type ReadingLevel = z.infer<typeof ReadingLevel>;

export const Brief = z
  .object({
    version: z.literal(BRIEF_VERSION),
    site: z.object({ url: z.url(), name: z.string().min(1) }),
    market: Market,
    /** The map page this brief is for. */
    page: z.object({
      nodeId: z.string().min(1),
      name: z.string().min(1),
      mainQuery: z.string().min(1),
      queries: z.array(z.string().min(1)).default([]),
      /** Where the page goes: its live URL when it exists, else the map's planned one. */
      url: z.string().min(1),
      /** The live page this brief rewrites, or null for a new page. */
      existingUrl: z.string().min(1).nullable(),
      action: z.enum(["keep", "improve", "resolve", "create"]),
      intent: PageIntent.shape.main,
      /** The persona the map says the page is mainly for (a persona id in the map). */
      persona: z.string().min(1).optional(),
    }),
    /**
     * The research this brief was made from: the topical map's run and date. When the map in the
     * folder has a newer createdAt, the research changed since this brief.
     */
    research: z.object({ runId: z.string().min(1), createdAt: z.iso.datetime() }),
    createdAt: z.iso.datetime(),
    /** Which run, step version, model and prompt wrote it (ADR 0009). */
    made: z.object({
      runId: z.string().min(1),
      stepVersion: z.string().min(1),
      model: z.string().min(1),
      prompt: z.object({ id: z.string().min(1), version: z.string().min(1) }),
    }),
    /** The one thing the reader should take away, in a sentence or two. */
    coreMessage: z.string().min(1),
    reader: z.object({
      /** What they search for and want to know. */
      searchesFor: z.string().min(1),
      /** How they feel when they arrive. */
      feels: z.string().min(1),
      /** What they do after reading. */
      doesNext: z.string().min(1),
    }),
    /** What makes this page different from the current top results, and the results it means. */
    difference: z.object({
      text: z.string().min(1),
      against: z.array(BriefResult).default([]),
    }),
    evidence: z.array(BriefEvidence).default([]),
    outline: z.array(BriefHeading).min(2),
    /** Angles not to take. */
    avoid: z.array(z.string().min(1)).default([]),
    questions: z.array(BriefQuestion).default([]),
    links: z.array(BriefLink).default([]),
    /** The reader's next action: the call to action, and the business's conversion behind it. */
    cta: z.object({
      action: z.string().min(1),
      conversion: BusinessProfile.shape.conversion,
    }),
    targets: z.object({
      words: z.number().int().positive(),
      /** H2s and H3s in the outline. */
      headings: z.number().int().nonnegative(),
      /** The main search, and how often the text uses it. */
      keyword: z.object({ term: z.string().min(1), uses: z.number().int().positive() }),
      readingLevel: ReadingLevel,
    }),
    /** Domain terms and the other names people search them by (map step 12.1): words to use. */
    terms: z.array(z.string().min(1)).default([]),
    /** What a person should look at before using the brief. */
    warnings: z.array(z.string()).default([]),
  })
  .superRefine((b, ctx) => {
    const first = b.outline[0];
    if (first?.level !== "h1") {
      ctx.addIssue({
        code: "custom",
        path: ["outline", 0],
        message: "the outline starts with the H1",
      });
    }
    let h2 = false;
    for (const [i, h] of b.outline.entries()) {
      if (i > 0 && h.level === "h1") {
        ctx.addIssue({ code: "custom", path: ["outline", i], message: "a page has one H1" });
      }
      if (h.level === "h2") h2 = true;
      if (h.level === "h3" && !h2) {
        ctx.addIssue({ code: "custom", path: ["outline", i], message: "an H3 comes under an H2" });
      }
    }
    const ids = new Set<string>();
    for (const [i, e] of b.evidence.entries()) {
      if (ids.has(e.id)) {
        ctx.addIssue({ code: "custom", path: ["evidence", i, "id"], message: `duplicate ${e.id}` });
      }
      ids.add(e.id);
    }
    for (const [i, h] of b.outline.entries()) {
      for (const [j, id] of h.evidence.entries()) {
        if (!ids.has(id)) {
          ctx.addIssue({
            code: "custom",
            path: ["outline", i, "evidence", j],
            message: `unknown evidence ${id}`,
          });
        }
      }
    }
    const headings = b.outline.filter((h) => h.level !== "h1").length;
    if (b.targets.headings !== headings) {
      ctx.addIssue({
        code: "custom",
        path: ["targets", "headings"],
        message: `the outline has ${headings} H2s and H3s, the target says ${b.targets.headings}`,
      });
    }
  });
export type Brief = z.infer<typeof Brief>;
