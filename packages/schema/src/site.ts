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
  /** Key of the site section the page lives in (a SiteSection's key), when the reader knows it. */
  section: z.string().min(1).optional(),
  /** The page's category inside its section (a blog category), in the site's own words. */
  category: z.string().min(1).optional(),
});
export type SitePage = z.infer<typeof SitePage>;

/**
 * Generic job of a site section (issue #51), whatever the site calls it: "Oplossingen" and
 * "Behandelingen" are both offer sections. Never a client-specific value.
 */
export const SECTION_ROLES = [
  "offer",
  "product",
  "category",
  "audience",
  "place",
  "knowledge",
  "proof",
  "pricing",
  "company",
] as const;
export const SectionRole = z.enum(SECTION_ROLES);
export type SectionRole = z.infer<typeof SectionRole>;

/** A folder path: "/" or "/a/" or "/a/b/". */
const Folder = z.string().regex(/^\/([a-z0-9-]+\/)*$/, "folder path like /kennisbank/");

/**
 * One section of the client's site: a WordPress post type, a menu group or a URL folder. A page
 * has a topic (its place in the topical map) and a section (its template and URL folder).
 */
export const SiteSection = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  /** In the site's own words ("Oplossingen", "Kennisbank"); never translated. */
  name: z.string().min(1),
  /** Where its pages live. "/" for pages at the root of the site (services at /dakreparatie/). */
  folder: Folder,
  /** Where Mycel found it, strongest first. */
  source: z.enum(["post_type", "menu", "folder", "owner"]),
  role: SectionRole.optional(),
  /** Sub-groups in the site's words, with their folder when they have one (/kennisbank/ai/). */
  categories: z.array(z.object({ name: z.string().min(1), folder: Folder.optional() })).default([]),
});
export type SiteSection = z.infer<typeof SiteSection>;

/** A main-menu group: a label with pages under it ("Diensten" over five service pages). */
export const MenuGroup = z.object({
  label: z.string().min(1),
  urls: z.array(z.string().startsWith("/")).min(1),
});
export type MenuGroup = z.infer<typeof MenuGroup>;

export const SitePages = z
  .object({
    site: z.string().min(1),
    source: z.enum(["fixture", "wordpress", "crawl"]),
    pages: z.array(SitePage).min(1),
    /** The site's sections, when the reader knows them (WordPress post types). */
    sections: z.array(SiteSection).default([]),
    /** Main-menu groups from the home page: they reveal sections that have no folder. */
    menu: z.array(MenuGroup).default([]),
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
