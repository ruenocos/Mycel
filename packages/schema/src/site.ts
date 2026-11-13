import { z } from "zod";

/**
 * One existing page of the client's site, as the pipeline sees it before mapping (step 15:
 * link existing pages to nodes). The WordPress reader and the test-client fixtures produce
 * the same shape, so the pipeline can't tell a fixture from a live site.
 */
export const SitePage = z.object({
  /** Path relative to the site root, e.g. "/kamerplanten/grote-kamerplanten/". */
  url: z.string().startsWith("/"),
  /** Generic page kind. Never a client-specific value. */
  kind: z.enum([
    "home",
    "category",
    "product",
    "service",
    "location",
    "guide",
    "blog",
    "pricing",
    "about",
    "contact",
    "other",
  ]),
  title: z.string().min(1),
  h1: z.string().min(1),
  metaDescription: z.string().min(1).optional(),
  /** The first lines of body text: enough to judge what the page is about. */
  text: z.string().min(1),
});
export type SitePage = z.infer<typeof SitePage>;

export const SitePages = z
  .object({
    site: z.string().min(1),
    source: z.enum(["fixture", "wordpress", "crawl"]),
    pages: z.array(SitePage).min(1),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    for (const [i, p] of s.pages.entries()) {
      if (seen.has(p.url)) {
        ctx.addIssue({ code: "custom", message: `duplicate url ${p.url}`, path: ["pages", i] });
      }
      seen.add(p.url);
    }
  });
export type SitePages = z.infer<typeof SitePages>;

/**
 * What a correct map must show for a test client (ADR 0011 data checks). Machine-checkable
 * half of the phase 2 gate; the human half is the client's checklist.md.
 */
export const GateExpectations = z.object({
  /** Main queries (or close variants) that must land in the core section: where the money is. */
  expectedCore: z.array(z.string().min(1)).min(1),
  /** Topics that belong in the outer section. */
  expectedOuter: z.array(z.string().min(1)).min(1),
  /** Two existing URLs that compete for the same intent. The map must flag them as a conflict. */
  plantedConflict: z.object({
    urls: z.tuple([z.string().startsWith("/"), z.string().startsWith("/")]),
    sharedIntent: z.string().min(1),
  }),
  /** Terms whose clusters must not appear in the map (homonyms, brands, place-name noise). */
  offTopic: z.array(z.string().min(1)).min(1),
});
export type GateExpectations = z.infer<typeof GateExpectations>;
