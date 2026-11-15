import { PLAN } from "./rules.ts";

/**
 * Priority as an action list. Every page gets what to do (keep, improve, resolve, create) and the
 * work is cut into a first plan an owner can review and act on: competing pages first, then pages
 * to improve and new pages by value, until about 30. Everything else waits ("later"). A new page
 * in the plan brings its new hub along, so nothing in the plan hangs under a page that doesn't
 * exist yet.
 */

export type Action = "keep" | "improve" | "resolve" | "create";

export interface ActionInput {
  id: string;
  isRoot: boolean;
  /** Parent id; undefined for the root. */
  parentId?: string;
  existing: "covered" | "weak" | null;
  conflict: boolean;
  /** Value of the page: tier x intent x demand (finish.ts). */
  score: number;
}

export interface PlannedAction {
  action: Action;
  wave?: "now" | "later";
  priority: number;
}

/** Improving a page that exists is cheaper than writing one, so it weighs more. */
const IMPROVE_BOOST = 1.5;

export function planActions(
  nodes: ActionInput[],
  plan: { size: number; max: number } = PLAN,
): Map<string, PlannedAction> {
  const out = new Map<string, PlannedAction>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const actionOf = (n: ActionInput): Action =>
    n.conflict ? "resolve" : n.existing === "covered" ? "keep" : n.existing ? "improve" : "create";
  for (const n of nodes) {
    if (n.isRoot) out.set(n.id, { action: n.existing ? "keep" : "create", priority: 1 });
  }
  const work = nodes.filter((n) => !n.isRoot && actionOf(n) !== "keep");
  const value = (n: ActionInput) => n.score * (actionOf(n) === "improve" ? IMPROVE_BOOST : 1);
  const resolve = work.filter((n) => actionOf(n) === "resolve").sort((a, b) => b.score - a.score);
  const rest = work.filter((n) => actionOf(n) !== "resolve").sort((a, b) => value(b) - value(a));

  const now: ActionInput[] = [];
  const inNow = new Set<string>();
  const add = (n: ActionInput) => {
    now.push(n);
    inNow.add(n.id);
  };
  for (const n of resolve) if (now.length < plan.max) add(n);
  for (const n of rest) {
    if (now.length >= plan.size) break;
    if (inNow.has(n.id)) continue;
    // A new page needs its new hubs in the plan too.
    const chain: ActionInput[] = [];
    for (let p = byId.get(n.parentId ?? ""); p && !p.isRoot; p = byId.get(p.parentId ?? "")) {
      if (actionOf(p) === "create" && !inNow.has(p.id)) chain.unshift(p);
    }
    if (actionOf(n) === "create" && now.length + chain.length + 1 > plan.max) continue;
    for (const p of actionOf(n) === "create" ? chain : []) add(p);
    add(n);
  }
  const later = [...resolve, ...rest].filter((n) => !inNow.has(n.id));
  now.forEach((n, i) => {
    const third = (i + 1) / now.length;
    out.set(n.id, {
      action: actionOf(n),
      wave: "now",
      priority: third <= 1 / 3 ? 1 : third <= 2 / 3 ? 2 : 3,
    });
  });
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
