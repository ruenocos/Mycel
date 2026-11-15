import type { BusinessProfile } from "@mycel/schema";
import type { FitReason, MapPlan, NodeDraft } from "./plan.ts";
import { tokens } from "./plan.ts";
import { QUESTION_WORDS } from "./rules.ts";
import type { PageRef } from "./site.ts";
import { buildSkeleton, type Cell, cellOf, noGoOf, type Skeleton } from "./skeleton.ts";
import { slugify } from "./urls.ts";

/**
 * Issue #42, step 3: pages attach to the business's offerings, with a hard gate. Data rules decide
 * what they can: a search for something the business doesn't do is left out, a search naming an
 * offering lands in its most specific cell, and every offering gets a page (a new one when no
 * search names it plainly). A core page that names no offering drops to outer; the model only
 * places what the words leave open (label.ts). Nothing here calls a model.
 */

export interface AttachResult {
  skeleton: Skeleton;
  /** Pages the data rules leave out, with the reason. */
  gate: Map<string, FitReason>;
  /** Offering pages, per offering id: locked under the root once site hubs are known. */
  anchors: Map<string, string>;
  /** The offering's own site page (its URL in the page list) -> its offering page. */
  pageLinks: Map<string, string>;
  stats: {
    cells: number;
    byWords: number;
    created: number;
    demoted: number;
    gated: number;
    /** Pages the words tie to no offering: the model may still name one. */
    open: number;
  };
}

const pathOf = (url: string) => {
  try {
    return new URL(url, "https://x.invalid").pathname;
  } catch {
    return url;
  }
};

/** The cell that most of a page's searches fall in, when its main search names none. */
function majorityCell(n: NodeDraft, sk: Skeleton, lang: string, top: Set<string>) {
  const hits = new Map<string, { cell: Cell; count: number }>();
  for (const q of n.queries) {
    const c = cellOf(tokens(q, lang), sk, top);
    if (c) hits.set(c.id, { cell: c, count: (hits.get(c.id)?.count ?? 0) + 1 });
  }
  const best = [...hits.values()].sort((a, b) => b.count - a.count)[0];
  return best && best.count * 2 > n.queries.length ? best.cell : undefined;
}

/** True when `id` is `from` or one of its ancestors (following parentId). */
function above(byId: Map<string, NodeDraft>, from: string | undefined, id: string) {
  const seen = new Set<string>();
  for (let p = from; p && !seen.has(p); p = byId.get(p)?.parentId) {
    if (p === id) return true;
    seen.add(p);
  }
  return false;
}

export function attachToBusiness(
  plan: MapPlan,
  business: BusinessProfile,
  pages: PageRef[] = [],
): AttachResult {
  const ctx = plan.context;
  const lang = ctx.market.language;
  const questions = QUESTION_WORDS[lang] ?? new Set<string>();
  const all = plan.entities.flatMap((e) => e.nodes);
  const sk = buildSkeleton(
    business,
    all.flatMap((n) => n.queries),
    lang,
    ctx.site.name,
  );
  const top = new Set(business.offerings.filter((o) => o.value === "top").map((o) => o.id));
  const gate = new Map<string, FitReason>();
  const cellOfNode = new Map<string, Cell>();
  const stats = { cells: sk.cells.length, byWords: 0, created: 0, demoted: 0, gated: 0, open: 0 };

  for (const n of all) {
    if (n.isRoot) continue;
    const words = tokens(n.mainQuery, lang);
    const cell = cellOf(words, sk, top) ?? majorityCell(n, sk, lang, top);
    const noGo = noGoOf(words, sk);
    // The owner's no wins, unless the search names an offering more precisely than the no-go.
    if (noGo && !(cell && cell.key.size > noGo.key.size)) {
      gate.set(n.id, "off_offer");
      stats.gated++;
      continue;
    }
    if (cell) {
      n.offeringId = cell.offeringId;
      cellOfNode.set(n.id, cell);
      stats.byWords++;
    } else if (n.section === "core") {
      // A core page sells something the business offers; without one it is supporting knowledge.
      n.section = "outer";
      stats.demoted++;
    }
  }

  // The page for each offering: the plainest search in its own cell, else a new page.
  const anchors = new Map<string, string>();
  const cellAnchor = new Map<string, NodeDraft>();
  const size = (n: NodeDraft) => tokens(n.mainQuery, lang).size;
  const isQuestion = (n: NodeDraft) => questions.has(n.mainQuery.trim().split(/\s+/)[0] ?? "");
  // A cell that is just a central entity ("Business Central") is the root's: no page of its own.
  const rootKeys = plan.entities.map((e) => [...tokens(e.entity, lang)].sort().join(" "));
  for (const cell of sk.cells) {
    if (cell.kind !== "offering" && rootKeys.includes([...cell.key].sort().join(" "))) continue;
    const inCell = all.filter(
      (n) => !n.isRoot && !gate.has(n.id) && cellOfNode.get(n.id)?.id === cell.id && !isQuestion(n),
    );
    const plainest = inCell.sort((a, b) => size(a) - size(b) || b.volume - a.volume)[0];
    // An offering's page is a plain search for it: the offering's words and at most one more.
    if (plainest && (cell.kind !== "offering" || size(plainest) <= cell.key.size + 1)) {
      cellAnchor.set(cell.id, plainest);
    }
  }
  for (const o of business.offerings) {
    let anchor = cellAnchor.get(o.id);
    if (!anchor) {
      const entity =
        plan.entities.find((e) => e.nodes.some((n) => n.offeringId === o.id)) ?? plan.entities[0];
      if (!entity) continue;
      let id = `o-${slugify(o.id)}`;
      for (let i = 2; entity.nodes.some((n) => n.id === id); i++) id = `o-${slugify(o.id)}-${i}`;
      anchor = {
        id,
        entity: entity.entity,
        isRoot: false,
        section: "core",
        mainQuery: o.name.toLowerCase(),
        queries: [],
        sections: [],
        volume: 0,
        gscImpressions: 0,
        intent: {
          main: ctx.market.city && !business.places.nationwide ? "local" : "commercial",
          mixed: false,
          source: "offering",
        },
        aiOverview: null,
        name: o.name,
        offeringId: o.id,
        qdpWhy:
          "One of the business's own offerings: every offering gets a page, so related pages have a home.",
      };
      entity.nodes.push(anchor);
      cellAnchor.set(o.id, anchor);
      stats.created++;
    }
    anchor.section = "core";
    anchor.offeringId = o.id;
    delete anchor.parentId;
    anchors.set(o.id, anchor.id);
  }

  // Pages hang under their cell's page, that under its offering's page, unless the word rule
  // already put them under a page of the same offering.
  for (const e of plan.entities) {
    const byId = new Map(e.nodes.map((n) => [n.id, n]));
    for (const n of e.nodes) {
      const cell = cellOfNode.get(n.id);
      if (n.isRoot || !cell || [...anchors.values()].includes(n.id)) continue;
      const own = cellAnchor.get(cell.id);
      const target = own && own !== n ? own : cellAnchor.get(cell.offeringId);
      if (!target || target === n || target.entity !== e.entity) continue;
      const current = n.parentId ? byId.get(n.parentId) : undefined;
      if (current && current.offeringId === n.offeringId) continue;
      if (n.section === "core" && target.section === "outer") continue;
      if (above(byId, target.id, n.id)) continue;
      n.parentId = target.id;
    }
  }

  // The offering's own site page belongs to its offering page.
  const pageLinks = new Map<string, string>();
  for (const o of business.offerings) {
    const anchor = anchors.get(o.id);
    const page = o.page && pages.find((p) => pathOf(p.url) === o.page);
    if (anchor && page) pageLinks.set(page.url, anchor);
  }
  stats.open = all.filter((n) => !n.isRoot && !gate.has(n.id) && !n.offeringId).length;
  return { skeleton: sk, gate, anchors, pageLinks, stats };
}

/** After site hubs are known: offering pages that aren't a site section are locked hubs too. */
export function lockOfferingHubs(plan: MapPlan, anchors: Map<string, string>) {
  const ids = new Set(anchors.values());
  for (const e of plan.entities) {
    for (const n of e.nodes) {
      if (!ids.has(n.id) || n.isRoot) continue;
      if (!n.hub) n.hub = "offering";
      delete n.parentId;
    }
  }
}
