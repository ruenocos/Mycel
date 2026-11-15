import { BUDGET } from "./rules.ts";
import { byValue, type Stage, type Tier } from "./value.ts";

/**
 * The page budget (issue #42, step 6). A small business can make about one page a week, so the
 * map holds a year of work: pages to fix and improve count first (existing pages first), new
 * pages get what is left. That share is split over the offerings by tier (BUDGET.tierWeight),
 * about 40% of each offering's share goes to pages that teach, and leftover room goes to the
 * best remaining pages by value. A page over budget goes to the backlog, or becomes a section of
 * the page above it when it is a close variant of it.
 *
 * Never cut: existing pages, offering pages, and the new pages an existing page hangs under.
 * A theme hub isn't a candidate itself: it stays when two of its pages stay.
 */

export interface BudgetNode {
  id: string;
  isRoot: boolean;
  parentId?: string;
  /** A new page (no existing page sits on it). */
  create: boolean;
  /** Existing work: an existing page to improve or a conflict to resolve. */
  work: boolean;
  /** Never cut (an offering's page). */
  locked: boolean;
  theme: boolean;
  offeringId?: string;
  tier: Tier;
  stage: Stage;
  value: number;
  volume: number;
  /** Words of its name and main search, to tell a close variant of its host. */
  words: Set<string>;
}

export interface BudgetResult {
  /** New pages the budget allowed (locked ones included). */
  budget: number;
  /** Existing work counted against the year. */
  work: number;
  /** Pages that stay. */
  kept: Set<string>;
  /** Cut pages that become a section of a kept page: host id → cut ids. */
  sections: Map<string, string[]>;
  /** Cut pages for the backlog. */
  backlog: string[];
  /** Theme hubs dropped: their kept pages move up to this parent. */
  dissolved: Map<string, string>;
}

export function applyBudget(
  nodes: BudgetNode[],
  budget: { work: number; learnShare: number; tierWeight: Record<Tier, number> } = BUDGET,
): BudgetResult {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kept = new Set<string>();
  let used = 0;
  const keep = (n: BudgetNode) => {
    if (kept.has(n.id)) return;
    kept.add(n.id);
    if (n.create && !n.theme && !n.isRoot) used++;
  };
  /** New ancestors a page needs (theme hubs are free). */
  const chainOf = (n: BudgetNode) => {
    const chain: BudgetNode[] = [];
    for (let p = byId.get(n.parentId ?? ""); p && !p.isRoot; p = byId.get(p.parentId ?? "")) {
      if (!kept.has(p.id)) chain.push(p);
    }
    return chain;
  };
  const cost = (chain: BudgetNode[]) => chain.filter((p) => p.create && !p.theme).length;

  // What always stays: the root, existing pages, offering pages, and what they hang under.
  const work = nodes.filter((n) => !n.isRoot && n.work).length;
  for (const n of nodes) {
    if (n.isRoot || !n.create || n.locked) {
      keep(n);
      for (const p of chainOf(n)) keep(p);
    }
  }
  const total = Math.max(used, budget.work - work);

  const candidates = nodes.filter((n) => !kept.has(n.id) && n.create && !n.theme);
  const take = (n: BudgetNode, limit: number) => {
    if (kept.has(n.id)) return true;
    const chain = chainOf(n);
    if (used + cost(chain) + 1 > limit) return false;
    for (const p of chain) keep(p);
    keep(n);
    return true;
  };

  // Each offering's share, by tier.
  const groups = new Map<string, BudgetNode[]>();
  for (const n of candidates) {
    const k = n.offeringId ?? "";
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  const room = total - used;
  const weight = (list: BudgetNode[]) => budget.tierWeight[(list[0] as BudgetNode).tier];
  const weights = [...groups.values()].reduce((s, list) => s + weight(list), 0);
  for (const list of groups.values()) {
    const quota = Math.max(1, Math.floor((room * weight(list)) / (weights || 1)));
    const limit = Math.min(total, used + quota);
    const learn = list.filter((n) => n.stage === "learn").sort(byValue);
    const learnSlots = Math.round(quota * budget.learnShare);
    let taken = 0;
    for (const n of learn) {
      if (taken >= learnSlots) break;
      if (take(n, limit)) taken++;
    }
    for (const n of [...list].sort(byValue)) take(n, limit);
  }
  // Room an offering didn't need goes to the best pages left.
  for (const n of [...candidates].sort(byValue)) take(n, total);

  // Theme hubs stay with two pages under them; otherwise their pages move up.
  const dissolved = new Map<string, string>();
  const parentOf = (id: string) => {
    let p = byId.get(id)?.parentId;
    while (p && dissolved.has(p)) p = dissolved.get(p);
    return p;
  };
  for (const n of nodes.filter((x) => x.theme)) {
    const kids = nodes.filter((x) => x.parentId === n.id && kept.has(x.id)).length;
    if (kids >= 2) kept.add(n.id);
    else {
      kept.delete(n.id);
      dissolved.set(n.id, n.parentId ?? "");
    }
  }

  // Cut pages: a close variant of the kept page above becomes its section, the rest backlog.
  const sections = new Map<string, string[]>();
  const backlog: string[] = [];
  for (const n of nodes) {
    if (kept.has(n.id) || n.isRoot || n.theme) continue;
    let host = byId.get(parentOf(n.id) ?? "");
    while (host && !host.isRoot && !kept.has(host.id)) host = byId.get(parentOf(host.id) ?? "");
    const close = host && !host.isRoot && [...n.words].some((w) => host?.words.has(w));
    if (host && close) sections.set(host.id, [...(sections.get(host.id) ?? []), n.id]);
    else backlog.push(n.id);
  }
  return { budget: total, work, kept, sections, backlog, dissolved };
}
