import type {
  BusinessProfile,
  MenuGroup,
  PageIntent,
  SectionRole,
  SitePage,
  SiteSection,
} from "@mycel/schema";
import { tokens } from "./plan.ts";

/**
 * Site sections (issue #51): every page has a topic (its place in the topical map) and a section
 * (its page type, template and URL folder). This file finds the site's sections, gives each a
 * generic role, and places every map page in one. Data and rules only; no model calls.
 */

type Kind = SitePage["kind"];
export type SectionPage = Pick<SitePage, "url" | "kind" | "title" | "h1"> &
  Partial<Pick<SitePage, "section" | "category">>;

/** Key of the catch-all for pages that sit in no section (root-level pages of a folder-less site). */
export const TOP_LEVEL = "top-level";

const firstFolder = (url: string) => {
  const parts = url.split("/").filter(Boolean);
  return parts.length >= 2 ? (parts[0] as string) : undefined;
};
const slugKey = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "section";
/** A folder's own words as a name: "tarieven-en-vergoeding" → "Tarieven en vergoeding". */
const folderName = (seg: string) => seg.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

export interface SiteSectionsResult {
  /** Every section with a role where the data or the owner gives one. */
  sections: SiteSection[];
  /** Existing page URL → its section key and category. */
  pageSection: Map<string, { key: string; category?: string }>;
}

/**
 * The site's sections, strongest source first: what the reader found (WordPress post types),
 * then main-menu groups for root-level pages (a "Diensten" menu over /dakreparatie/ and
 * /dakgoten/), then URL folders with 2 or more pages. Pages left over sit in the top level.
 */
export function siteSections(input: {
  pages: SectionPage[];
  sections?: SiteSection[];
  menu?: MenuGroup[];
  business?: BusinessProfile;
  language: string;
}): SiteSectionsResult {
  const { pages, business, language } = input;
  const owner = new Map((business?.siteSections ?? []).map((o) => [o.key, o]));
  const sections = new Map<string, SiteSection>();
  const pageSection = new Map<string, { key: string; category?: string }>();
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  for (const s of input.sections ?? []) sections.set(s.key, { ...s });
  for (const p of pages)
    if (p.section && sections.has(p.section))
      pageSection.set(p.url, { key: p.section, ...(p.category ? { category: p.category } : {}) });

  // Root-level pages a menu groups together are a section without a folder. A page only moves
  // out of a section that is just "everything at the root" (WordPress pages), never out of a
  // real one.
  const loose = (url: string) => {
    const at = pageSection.get(url);
    return !at || sections.get(at.key)?.folder === "/";
  };
  for (const g of input.menu ?? []) {
    const members = g.urls.filter(
      (u) => byUrl.has(u) && u.split("/").filter(Boolean).length === 1 && loose(u),
    );
    if (members.length < 2) continue;
    let key = slugKey(g.label);
    if (sections.has(key)) key = `menu-${key}`;
    sections.set(key, { key, name: g.label, folder: "/", source: "menu", categories: [] });
    for (const u of members) pageSection.set(u, { key });
    // Sub-pages of a grouped page follow it (/plat-dak/epdm/ under /plat-dak/).
    for (const p of pages) {
      const top = firstFolder(p.url);
      if (top && members.includes(`/${top}/`) && loose(p.url)) pageSection.set(p.url, { key });
    }
  }

  // URL folders with 2 or more pages the reader left unplaced.
  const byFolder = new Map<string, SectionPage[]>();
  for (const p of pages) {
    const f = firstFolder(p.url);
    if (f && !pageSection.has(p.url)) byFolder.set(f, [...(byFolder.get(f) ?? []), p]);
  }
  for (const [f, list] of byFolder) {
    // The folder's own landing page (/blog/) belongs to it too.
    const landing = byUrl.get(`/${f}/`);
    const members = landing && !pageSection.has(landing.url) ? [...list, landing] : list;
    if (members.length < 2) continue;
    let key = slugKey(f);
    if (sections.has(key)) key = `folder-${key}`;
    sections.set(key, {
      key,
      name: folderName(f),
      folder: `/${f}/`,
      source: "folder",
      categories: [],
    });
    for (const p of members) pageSection.set(p.url, { key });
  }

  const leftover = pages.filter((p) => !pageSection.has(p.url));
  if (leftover.length && !sections.has(TOP_LEVEL)) {
    sections.set(TOP_LEVEL, {
      key: TOP_LEVEL,
      name: "Top level",
      folder: "/",
      source: "folder",
      categories: [],
    });
  }
  for (const p of leftover) pageSection.set(p.url, { key: TOP_LEVEL });

  // Roles: the owner's word, else a guess from the data; a name the owner gave replaces the
  // site's; a section the owner ignores keeps its pages but takes no new ones (no role).
  for (const s of sections.values()) {
    const o = owner.get(s.key);
    // The home page says nothing about a section; the top level is no section to guess for.
    const members = pages.filter((p) => pageSection.get(p.url)?.key === s.key && p.kind !== "home");
    const guess = s.key === TOP_LEVEL ? undefined : guessRole(members, business, language);
    const role = o?.ignore ? undefined : (o?.role ?? guess);
    if (role) s.role = role;
    else delete s.role;
    if (o?.name) s.name = o.name;
  }
  return { sections: [...sections.values()], pageSection };
}

const KIND_ROLE: Partial<Record<Kind, SectionRole>> = {
  service: "offer",
  category: "category",
  product: "product",
  location: "place",
  blog: "knowledge",
  guide: "knowledge",
  pricing: "pricing",
  home: "company",
  about: "company",
  contact: "company",
};
const OFFER_ROLE = {
  service: "offer",
  product_line: "product",
  product_category: "category",
} as const;

/** Most common value when it covers at least half the list. */
function majority<T>(values: T[]): T | undefined {
  const count = new Map<T, number>();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  const [best] = [...count].sort((a, b) => b[1] - a[1]);
  return best && best[1] * 2 >= values.length ? best[0] : undefined;
}

/** Audience words of the business: offering audiences and audience-like attribute values. */
export function audienceTerms(business: BusinessProfile | undefined): string[] {
  return [
    ...new Set(
      (business?.offerings ?? []).flatMap((o) => [
        ...o.audiences,
        ...o.attributes
          .filter((a) => o.audiences.some((x) => a.values.includes(x)))
          .flatMap((a) => a.values),
      ]),
    ),
  ];
}

/** Place words of the business: location names and cities, and the areas it serves. */
export function placeTerms(business: BusinessProfile | undefined): string[] {
  const places = business?.places;
  return [
    ...new Set([
      ...(places?.locations ?? []).flatMap((l) => [l.name, l.city]),
      ...(places?.serves ?? []),
    ]),
  ];
}

const mentions = (text: string, terms: string[], language: string) => {
  const t = tokens(text, language);
  return terms.some((term) => {
    const w = tokens(term, language);
    return w.size > 0 && [...w].every((x) => t.has(x));
  });
};

/**
 * A section's role from its pages: the offerings whose own page sits there, then pages named
 * after the business's places or audiences, then the page kinds. Undefined when the data can't
 * tell (a section of customer stories): the owner names it in the business setup.
 */
export function guessRole(
  members: SectionPage[],
  business: BusinessProfile | undefined,
  language: string,
): SectionRole | undefined {
  if (!members.length) return undefined;
  const urls = new Set(members.map((p) => p.url));
  const offerKinds = (business?.offerings ?? [])
    .filter((o) => o.page && urls.has(o.page))
    .map((o) => OFFER_ROLE[o.kind]);
  if (offerKinds.length * 2 >= members.length) return majority(offerKinds);
  const named = (terms: string[]) =>
    terms.length > 0 &&
    members.filter((p) => mentions(`${p.h1} ${p.title}`, terms, language)).length * 2 >
      members.length;
  if (named(placeTerms(business))) return "place";
  if (named(audienceTerms(business))) return "audience";
  if (offerKinds.length) return majority(offerKinds);
  const kinds = members.map((p) => KIND_ROLE[p.kind]).filter((r): r is SectionRole => !!r);
  return kinds.length * 2 >= members.length ? majority(kinds) : undefined;
}

export interface SectionNode {
  id: string;
  isRoot: boolean;
  tier: "core" | "outer";
  intent: PageIntent["main"];
  mainQuery: string;
  /** The page's display name, when known. */
  name?: string;
  hub?: "site" | "theme" | "offering";
  offeringId?: string;
  /** The existing page that serves this node. */
  existing?: string;
}

export interface NodeSection {
  key: string;
  category?: string;
  suggested?: boolean;
  why: string;
}

/** A section the site lacks is only suggested when at least this many pages would go there. */
export const MIN_SUGGESTED_PAGES = 3;

/** Sections the site lacks but the map needs: a place for local pages, a home for articles. */
const SUGGEST: Partial<Record<SectionRole, string>> = {
  knowledge: "Knowledge base (suggested)",
  place: "Places (suggested)",
};

/**
 * One section for every map page, by rules (plan doc, "How each map page gets its page type"):
 * an existing page keeps its own; an offering's page goes to the section for its kind; a local
 * page to the place section; a page for an audience to the audience section; a question page to
 * the knowledge section (and its closest category); else the section of its nearest hub with a
 * page; else the offer section; else the top level. A role the site has no section for becomes a
 * suggested section.
 */
export function assignSections(input: {
  nodes: SectionNode[];
  parent: Map<string, string>;
  site: SiteSectionsResult;
  business?: BusinessProfile;
  language: string;
}): { of: Map<string, NodeSection>; suggested: SiteSection[] } {
  const { nodes, parent, site, business, language } = input;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byRole = new Map<SectionRole, SiteSection>();
  // The biggest section per role wins when two share one.
  const size = (key: string) => [...site.pageSection.values()].filter((v) => v.key === key).length;
  for (const s of [...site.sections].sort((a, b) => size(b.key) - size(a.key)))
    if (s.role && !byRole.has(s.role)) byRole.set(s.role, s);
  const offerings = new Map((business?.offerings ?? []).map((o) => [o.id, o]));
  const audiences = audienceTerms(business);
  const suggested = new Map<SectionRole, SiteSection>();
  // Roles not worth a new section: too few pages would go there (second pass).
  const tooSmall = new Set<SectionRole>();
  const roleSection = (role: SectionRole): { s: SiteSection; suggested?: boolean } | undefined => {
    const s = byRole.get(role);
    if (s) return { s };
    const name = SUGGEST[role];
    if (!name || tooSmall.has(role)) return undefined;
    const made = suggested.get(role) ?? {
      key: `suggested-${role}`,
      name,
      folder: "/",
      source: "owner" as const,
      role,
      categories: [],
    };
    suggested.set(role, made);
    return { s: made, suggested: true };
  };
  const knowledgeCategory = (n: SectionNode, s: SiteSection): string | undefined => {
    if (!s.categories.length) return undefined;
    // The words of the page and its hubs; the category sharing most of them wins.
    const words = new Set<string>();
    for (let cur: SectionNode | undefined = n; cur && !cur.isRoot; ) {
      for (const t of tokens(`${cur.name ?? ""} ${cur.mainQuery}`, language)) words.add(t);
      const up = parent.get(cur.id);
      cur = up ? byId.get(up) : undefined;
    }
    const scored = s.categories
      .map((c) => ({ c, hits: [...tokens(c.name, language)].filter((t) => words.has(t)).length }))
      .sort((a, b) => b.hits - a.hits);
    return scored[0]?.hits ? scored[0].c.name : undefined;
  };
  const of = new Map<string, NodeSection>();
  const place = (n: SectionNode): NodeSection => {
    if (n.existing) {
      const at = site.pageSection.get(n.existing);
      if (at) return { ...at, why: "existing page" };
    }
    const offering = n.offeringId ? offerings.get(n.offeringId) : undefined;
    if (n.hub === "offering" && offering) {
      const r = roleSection(OFFER_ROLE[offering.kind]);
      if (r) return { key: r.s.key, why: `page for an offering (${offering.kind})` };
    }
    const informational = n.intent === "informational";
    if (n.intent === "local") {
      const r = roleSection("place");
      if (r)
        return { key: r.s.key, ...(r.suggested ? { suggested: true } : {}), why: "local page" };
    }
    if (!informational && audiences.length && mentions(n.mainQuery, audiences, language)) {
      const s = byRole.get("audience");
      if (s) return { key: s.key, why: "page for an audience the business serves" };
    }
    if (informational) {
      const r = roleSection("knowledge");
      if (r) {
        const category = r.suggested ? undefined : knowledgeCategory(n, r.s);
        return {
          key: r.s.key,
          ...(category ? { category } : {}),
          ...(r.suggested ? { suggested: true } : {}),
          why: "question or how-to page",
        };
      }
    }
    // The nearest hub with an existing page in an offer-like section.
    for (let up = parent.get(n.id); up; up = parent.get(up)) {
      const hub = byId.get(up);
      if (!hub || hub.isRoot) break;
      const at = hub.existing ? site.pageSection.get(hub.existing) : undefined;
      const role = at ? site.sections.find((s) => s.key === at.key)?.role : undefined;
      if (at && role && role !== "knowledge" && role !== "company" && role !== "proof")
        return { key: at.key, why: "under a page of this section" };
    }
    for (const role of ["offer", "category", "product"] as const) {
      const s = byRole.get(role);
      if (s) return { key: s.key, why: `default section for ${role} pages` };
    }
    return { key: TOP_LEVEL, why: "the site has no section for it" };
  };
  for (const n of nodes) if (!n.isRoot) of.set(n.id, place(n));
  // A suggested section needs a few pages to be worth building; else its pages go elsewhere.
  const used = (key: string) => [...of.values()].filter((v) => v.key === key).length;
  for (const [role, s] of suggested)
    if (used(s.key) < MIN_SUGGESTED_PAGES) {
      tooSmall.add(role);
      suggested.delete(role);
    }
  if (tooSmall.size) for (const n of nodes) if (!n.isRoot) of.set(n.id, place(n));
  return { of, suggested: [...suggested.values()] };
}

/** The folder a new page in this section goes to: its category's folder, else the section's. */
export function sectionFolder(s: SiteSection | undefined, category?: string): string | undefined {
  if (!s) return undefined;
  const c = category ? s.categories.find((x) => x.name === category) : undefined;
  return c?.folder ?? s.folder;
}
