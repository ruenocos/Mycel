import { tokens } from "./plan.ts";
import { SKIP_KINDS } from "./rules.ts";
import { isHome, type PageRef, type PageScore } from "./site.ts";

/**
 * Existing pages first (issue #42, step 5): every page of the site gets a job in the map before
 * new pages count. serves: it is a node's page. competes: it fights another page for a node
 * (that node's conflict says merge or differentiate). supports: it belongs under a node without
 * being its page, like a product in its category or an article under its topic. outside: no job,
 * with the reason, so the gap is visible.
 */

export type Job = "serves" | "competes" | "supports" | "outside";

export interface InventoryEntry {
  url: string;
  kind: string;
  title: string;
  job: Job;
  nodeId?: string;
  reason?: string;
}

export interface InventoryNode {
  id: string;
  isRoot: boolean;
  section: "core" | "outer";
  name?: string;
  /** The node's own page, then any other page linked to it. */
  pages: string[];
  /** URLs in the node's conflict (its own pages and rivals). */
  conflict: string[];
}

/** Word score a support page needs to sit under a node by its words alone. */
export const SUPPORT_SCORE = 0.5;

const PRODUCT_KINDS = new Set(["product"]);
const ARTICLE_KINDS = new Set(["blog", "guide"]);

export function pageInventory(input: {
  nodes: InventoryNode[];
  pages: PageRef[];
  scores: Map<string, Map<string, PageScore>>;
  language: string;
  title: (p: PageRef) => string;
}): InventoryEntry[] {
  const { nodes, pages, scores, language } = input;
  const serves = new Map<string, string>();
  const competes = new Map<string, string>();
  for (const n of nodes) {
    const [own, ...rest] = n.pages;
    if (own && !serves.has(own)) serves.set(own, n.id);
    for (const url of [...rest, ...n.conflict]) {
      if (url !== own && !competes.has(url)) competes.set(url, n.id);
    }
  }
  const pageWords = new Map(pages.map((p) => [p.url, tokens(`${p.title} ${p.h1}`, language)]));
  const real = nodes.filter((n) => !n.isRoot);
  /** The node a category names: its name or its own page's words hold every category word. */
  const byCategory = (category: string) => {
    const want = tokens(category, language);
    if (!want.size) return undefined;
    const has = (words: Set<string>) => [...want].every((w) => words.has(w));
    return (
      real.find((n) => n.pages[0] && has(pageWords.get(n.pages[0]) ?? new Set())) ??
      real.find((n) => has(tokens(n.name ?? "", language)))
    );
  };
  const out: InventoryEntry[] = [];
  for (const p of pages) {
    if (isHome(p) || SKIP_KINDS.has(p.kind)) continue;
    const base = { url: p.url, kind: p.kind, title: input.title(p) };
    const own = serves.get(p.url);
    if (own) {
      out.push({ ...base, job: "serves", nodeId: own });
      continue;
    }
    const rival = competes.get(p.url);
    if (rival) {
      out.push({ ...base, job: "competes", nodeId: rival });
      continue;
    }
    const cat = p.category ? byCategory(p.category) : undefined;
    if (cat) {
      out.push({ ...base, job: "supports", nodeId: cat.id, reason: `category ${p.category}` });
      continue;
    }
    // By its words: a product under a page that sells, an article under one that teaches.
    const prefer = PRODUCT_KINDS.has(p.kind) ? "core" : ARTICLE_KINDS.has(p.kind) ? "outer" : null;
    const best = real
      .map((n) => ({ n, s: scores.get(p.url)?.get(n.id)?.score ?? 0 }))
      .filter((x) => x.s >= SUPPORT_SCORE)
      .sort(
        (a, b) =>
          Number(b.n.section === prefer) - Number(a.n.section === prefer) ||
          b.s - a.s ||
          Number(!!b.n.pages[0]) - Number(!!a.n.pages[0]),
      )[0];
    if (best) {
      out.push({ ...base, job: "supports", nodeId: best.n.id, reason: "shares its topic" });
      continue;
    }
    out.push({ ...base, job: "outside", reason: "no map page on its topic" });
  }
  return out;
}
