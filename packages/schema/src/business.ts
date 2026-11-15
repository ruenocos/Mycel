import { z } from "zod";

/**
 * The business profile (issue #42, step 1; Koray steps 1-6 made specific). AI fills every field it
 * can prove from the site and search data, the owner confirms, corrects or adds the rest. Every
 * later map rule checks against it: the offer gate, places served, the plan order and the facts a
 * why-text may claim. Values are in the market language; field names and enums in English.
 */

/** Where a value came from. Site and search values carry the page or data that proves them. */
export const Source = z.object({
  from: z.enum(["site", "search", "owner"]),
  /** A site path ("/behandelingen/dry-needling/") or a data reference ("gsc", "ranked:dry needling"). */
  ref: z.string().min(1).optional(),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
});
export type Source = z.infer<typeof Source>;

/** An attribute of an offering with its values, e.g. size: [klein, groot, XXL]; sector: [bouw]. */
export const OfferingAttribute = z.object({
  name: z.string().min(1),
  values: z.array(z.string().min(1)).min(1),
});
export type OfferingAttribute = z.infer<typeof OfferingAttribute>;

/** Fields a person can be asked to fill when AI found no proof. */
export const OFFERING_FIELDS = [
  "subOfferings",
  "attributes",
  "audiences",
  "places",
  "priceRange",
  "proofPoints",
  "seasonality",
] as const;
export const OfferingField = z.enum(OFFERING_FIELDS);
export type OfferingField = z.infer<typeof OfferingField>;

export const Offering = z.object({
  /** Stable slug; map nodes point at it (offeringId). */
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  kind: z.enum(["service", "product_category", "product_line"]),
  /** The site's own page for it, when there is one. */
  page: z.string().startsWith("/").optional(),
  subOfferings: z.array(z.string().min(1)).default([]),
  attributes: z.array(OfferingAttribute).default([]),
  audiences: z.array(z.string().min(1)).default([]),
  /** Where it is delivered; empty means everywhere the business serves. */
  places: z.array(z.string().min(1)).default([]),
  priceRange: z.string().min(1).optional(),
  /** What makes it worth choosing, only with proof: certifications, years, cases, review themes. */
  proofPoints: z.array(z.string().min(1)).default([]),
  seasonality: z.string().min(1).optional(),
  /** top: main earner or what the owner wants to grow. side: offered, rarely asked for. */
  value: z.enum(["top", "normal", "side"]).default("normal"),
  sources: z.array(Source).min(1),
  /** Fields AI found no proof for: asked in the setup, never guessed. */
  unknown: z.array(OfferingField).default([]),
  status: z.enum(["proposed", "confirmed", "edited", "added"]).default("proposed"),
});
export type Offering = z.infer<typeof Offering>;

/** Something the business does not do. Searches for it never get a page. */
export const NotOffered = z.object({
  name: z.string().min(1),
  /** Other ways it is searched for ("kaakfysio" for "kaakfysiotherapie"). */
  aliases: z.array(z.string().min(1)).default([]),
  sources: z.array(Source).min(1),
});
export type NotOffered = z.infer<typeof NotOffered>;

/** A fact a why-text may use (truth gate): only what is in the profile can be claimed. */
export const BusinessFact = z.object({
  fact: z.string().min(1),
  sources: z.array(Source).min(1),
});
export type BusinessFact = z.infer<typeof BusinessFact>;

export const Location = z.object({
  name: z.string().min(1),
  city: z.string().min(1),
  address: z.string().min(1).optional(),
  page: z.string().startsWith("/").optional(),
});
export type Location = z.infer<typeof Location>;

export const BusinessProfile = z.object({
  offerings: z.array(Offering).min(1),
  notOffered: z.array(NotOffered).default([]),
  places: z
    .object({
      /** Physical locations (addresses customers visit). */
      locations: z.array(Location).default([]),
      /** Towns, districts or regions served, including from the locations. Empty: nationwide. */
      serves: z.array(z.string().min(1)).default([]),
      /** True for a webshop or remote service: places don't limit the map. */
      nationwide: z.boolean().default(false),
    })
    .default({ locations: [], serves: [], nationwide: false }),
  /** What a visitor should do: the money moment. */
  conversion: z.enum(["book", "quote", "buy", "call", "contact"]).optional(),
  differentiators: z.array(BusinessFact).default([]),
  facts: z.array(BusinessFact).default([]),
  brand: z
    .object({
      /** The business's own names and product names. */
      own: z.array(z.string().min(1)).default([]),
      /** Partner, supplier or competitor brands never to target. */
      neverTarget: z.array(z.string().min(1)).default([]),
      /** Words the business doesn't want used. */
      avoidWords: z.array(z.string().min(1)).default([]),
    })
    .default({ own: [], neverTarget: [], avoidWords: [] }),
  /** How the site names things ("behandelingen", "kennisbank"): names, folders and URLs follow it. */
  siteTerms: z.array(z.object({ term: z.string().min(1), meaning: z.string().min(1) })).default([]),
  /** Questions for the owner that AI could not settle (e.g. "Do you offer X?", from competitors). */
  openQuestions: z.array(z.string().min(1)).default([]),
  confirmed: z.object({ by: z.string().min(1), at: z.iso.datetime() }).optional(),
});
export type BusinessProfile = z.infer<typeof BusinessProfile>;

/**
 * What the owner said in the setup, as a file Claude or the onboarding writes from their taps.
 * Applied on top of the proposed profile; the owner's word always wins.
 */
export const OwnerAnswers = z.object({
  by: z.string().min(1),
  at: z.iso.datetime(),
  /** Offering ids the owner removed: they move to notOffered. */
  removed: z.array(z.string()).default([]),
  /**
   * Offerings that are part of another one ("XL kamerplanten" under "grote kamerplanten"): the
   * offering folds into `into` as a sub-offering. Not the same as removed: it is still offered.
   */
  merged: z.array(z.object({ id: z.string().min(1), into: z.string().min(1) })).default([]),
  /** Field edits per offering id; only the fields given are replaced. */
  edits: z
    .array(
      z.object({
        id: z.string().min(1),
        set: Offering.partial().omit({ id: true, sources: true, status: true, unknown: true }),
      }),
    )
    .default([]),
  /** New offerings the owner added. */
  added: z
    .array(Offering.omit({ sources: true, status: true, unknown: true }).partial({ kind: true }))
    .default([]),
  /** Offering ids that are the top earners or should grow; all others drop to normal or side. */
  top: z.array(z.string()).default([]),
  notOffered: z
    .array(z.object({ name: z.string().min(1), aliases: z.array(z.string()).default([]) }))
    .default([]),
  places: z
    .object({
      locations: z.array(Location).optional(),
      serves: z.array(z.string().min(1)).optional(),
      nationwide: z.boolean().optional(),
    })
    .optional(),
  conversion: BusinessProfile.shape.conversion,
  facts: z.array(z.string().min(1)).default([]),
  brand: z
    .object({
      own: z.array(z.string()).optional(),
      neverTarget: z.array(z.string()).optional(),
      avoidWords: z.array(z.string()).optional(),
    })
    .optional(),
});
export type OwnerAnswers = z.infer<typeof OwnerAnswers>;
