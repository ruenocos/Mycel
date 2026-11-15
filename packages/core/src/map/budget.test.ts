import { describe, expect, it } from "vitest";
import { applyBudget, type BudgetNode } from "./budget.ts";

const n = (id: string, over: Partial<BudgetNode> = {}): BudgetNode => ({
  id,
  isRoot: false,
  parentId: "root",
  create: true,
  work: false,
  locked: false,
  theme: false,
  tier: "normal",
  stage: "buy",
  value: 0.5,
  volume: 10,
  words: new Set([id]),
  ...over,
});

describe("applyBudget", () => {
  it("keeps a year of work: existing work first, new pages split by tier, the rest to the backlog", () => {
    const nodes: BudgetNode[] = [
      n("root", { isRoot: true, create: false }),
      n("fix", { create: false, work: true }),
      n("hub-a", { locked: true, offeringId: "a", tier: "top" }),
      n("hub-b", { locked: true, offeringId: "b", tier: "side" }),
      ...Array.from({ length: 10 }, (_, i) =>
        n(`a${i}`, {
          parentId: "hub-a",
          offeringId: "a",
          tier: "top",
          value: 1 - i / 100,
          words: new Set([`x${i}`]),
        }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        n(`b${i}`, {
          parentId: "hub-b",
          offeringId: "b",
          tier: "side",
          value: 0.3 - i / 100,
          words: new Set([`y${i}`]),
        }),
      ),
    ];
    const r = applyBudget(nodes, {
      work: 10,
      learnShare: 0,
      tierWeight: { top: 3, normal: 2, side: 1, none: 1 },
    });
    expect(r.work).toBe(1);
    expect(r.budget).toBe(9);
    // Offering pages and existing pages always stay; 7 more new pages fit.
    const kept = [...r.kept].filter((id) => /^[ab]\d$/.test(id));
    expect(kept).toHaveLength(7);
    expect(kept.filter((id) => id.startsWith("a")).length).toBeGreaterThan(
      kept.filter((id) => id.startsWith("b")).length,
    );
    expect(r.kept.has("fix") && r.kept.has("hub-a") && r.kept.has("hub-b")).toBe(true);
    expect(r.backlog).toHaveLength(13);
  });

  it("keeps the new pages an existing page hangs under, keeps room for pages that teach, and folds close variants", () => {
    const nodes: BudgetNode[] = [
      n("root", { isRoot: true, create: false }),
      n("hub", { locked: true, offeringId: "a", words: new Set(["kosten", "dak"]) }),
      n("topic", { parentId: "hub", offeringId: "a", value: 0.1 }),
      n("article", { parentId: "topic", create: false }),
      n("sell", { parentId: "hub", offeringId: "a", value: 0.9 }),
      n("question", { parentId: "hub", offeringId: "a", stage: "learn", value: 0.2 }),
      n("variant", {
        parentId: "hub",
        offeringId: "a",
        value: 0.05,
        words: new Set(["kosten", "plat"]),
      }),
    ];
    const r = applyBudget(nodes, {
      work: 4,
      learnShare: 0.5,
      tierWeight: { top: 3, normal: 2, side: 1, none: 1 },
    });
    expect(r.kept.has("topic")).toBe(true);
    expect(r.kept.has("question")).toBe(true);
    expect(r.kept.has("sell")).toBe(true);
    expect(r.sections.get("hub")).toEqual(["variant"]);
  });

  it("drops a theme hub left with one page and moves that page up", () => {
    const nodes: BudgetNode[] = [
      n("root", { isRoot: true, create: false }),
      n("theme", { theme: true }),
      n("t1", { parentId: "theme", value: 0.9 }),
      n("t2", { parentId: "theme", value: 0.01 }),
    ];
    const r = applyBudget(nodes, {
      work: 1,
      learnShare: 0,
      tierWeight: { top: 3, normal: 2, side: 1, none: 1 },
    });
    expect(r.kept.has("t1")).toBe(true);
    expect(r.kept.has("theme")).toBe(false);
    expect(r.dissolved.get("theme")).toBe("root");
    expect(r.backlog).toEqual(["t2"]);
  });
});
