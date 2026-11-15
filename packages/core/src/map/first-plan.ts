import { PLAN } from "./rules.ts";
import { byValue } from "./value.ts";

/**
 * The first plan (issue #42, step 6). Every page gets what to do (keep, improve, resolve,
 * create); then about 10 steps an owner can start on, in this order:
 *
 * 1. conflicts on money pages (pages that sell: core, or a buy or compare search);
 * 2. existing money pages of the top offerings to improve;
 * 3. missing pages for the top offerings;
 * 4. their support pages.
 *
 * Within each group the value score decides, volume breaks ties. Every step is tied to a top
 * offering or a conflict: work for other offerings waits ("later"), however big its search. A
 * new page brings its new hubs along, so nothing in the plan hangs under a page that doesn't
 * exist yet.
 */

export type Action = "keep" | "improve" | "resolve" | "create";

export interface PlanInput {
  id: string;
  isRoot: boolean;
  /** Parent id; undefined for the root. */
  parentId?: string;
  existing: "covered" | "weak" | null;
  conflict: boolean;
  /** What the page is worth (value.ts). */
  value: number;
  volume: number;
  /** A page that sells: core, or a buy or compare search. */
  money: boolean;
  /** It serves one of the top offerings (value.ts topOfferings). */
  top: boolean;
}

export interface PlannedAction {
  action: Action;
  wave?: "now" | "later";
  /** Place in the first plan, 1 = first; only for "now". */
  step?: number;
  priority: number;
}

export const actionOf = (n: Pick<PlanInput, "conflict" | "existing">): Action =>
  n.conflict ? "resolve" : n.existing === "covered" ? "keep" : n.existing ? "improve" : "create";

/** Which plan group a page falls in (1-4, see above); undefined: not in the first plan. */
function groupOf(n: PlanInput): number | undefined {
  const a = actionOf(n);
  if (a === "resolve") return n.money || n.top ? 1 : undefined;
  if (!n.top) return undefined;
  if (a === "improve") return n.money ? 2 : 4;
  if (a === "create") return n.money ? 3 : 4;
  return undefined;
}

export function planFirst(
  nodes: PlanInput[],
  plan: { size: number; max: number } = PLAN,
): Map<string, PlannedAction> {
  const out = new Map<string, PlannedAction>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (n.isRoot) out.set(n.id, { action: n.existing ? "keep" : "create", priority: 1 });
  }
  const work = nodes.filter((n) => !n.isRoot && actionOf(n) !== "keep");
  const candidates = work
    .map((n) => ({ n, group: groupOf(n) }))
    .filter((x): x is { n: PlanInput; group: number } => x.group !== undefined)
    .sort((a, b) => a.group - b.group || byValue(a.n, b.n));

  const now: PlanInput[] = [];
  const inNow = new Set<string>();
  const add = (n: PlanInput) => {
    now.push(n);
    inNow.add(n.id);
  };
  for (const { n, group } of candidates) {
    if (inNow.has(n.id)) continue;
    if (group === 1) {
      if (now.length < plan.max) add(n);
      continue;
    }
    if (now.length >= plan.size) break;
    // A new page needs its new hubs in the plan too.
    const chain: PlanInput[] = [];
    for (let p = byId.get(n.parentId ?? ""); p && !p.isRoot; p = byId.get(p.parentId ?? "")) {
      if (actionOf(p) === "create" && !inNow.has(p.id)) chain.unshift(p);
    }
    if (actionOf(n) === "create" && now.length + chain.length + 1 > plan.max) continue;
    // Every step is tied: a new hub that serves no top offering keeps the page out of the plan.
    if (actionOf(n) === "create" && chain.some((p) => !p.top)) continue;
    for (const p of actionOf(n) === "create" ? chain : []) add(p);
    add(n);
  }
  now.forEach((n, i) => {
    const third = (i + 1) / now.length;
    out.set(n.id, {
      action: actionOf(n),
      wave: "now",
      step: i + 1,
      priority: third <= 1 / 3 ? 1 : third <= 2 / 3 ? 2 : 3,
    });
  });
  const later = work.filter((n) => !inNow.has(n.id)).sort(byValue);
  later.forEach((n, i) => {
    out.set(n.id, {
      action: actionOf(n),
      wave: "later",
      priority: (i + 1) / later.length <= 0.5 ? 4 : 5,
    });
  });
  for (const n of nodes) if (!out.has(n.id)) out.set(n.id, { action: "keep", priority: 5 });
  return out;
}
