import { describe, expect, it } from "vitest";
import { type PlanInput, planFirst } from "./first-plan.ts";

const page = (id: string, over: Partial<PlanInput> = {}): PlanInput => ({
  id,
  isRoot: false,
  parentId: "root",
  existing: null,
  conflict: false,
  value: 0.5,
  volume: 10,
  money: true,
  top: true,
  ...over,
});
const root = page("root", { isRoot: true, existing: "covered" });

describe("planFirst", () => {
  it("gives each page what to do: keep, improve, resolve or create", () => {
    const out = planFirst([
      root,
      page("ok", { existing: "covered" }),
      page("weak", { existing: "weak" }),
      page("clash", { existing: "covered", conflict: true }),
      page("new"),
    ]);
    expect(out.get("root")).toEqual({ action: "keep", priority: 1 });
    expect(out.get("ok")).toEqual({ action: "keep", priority: 5 });
    expect(out.get("weak")?.action).toBe("improve");
    expect(out.get("clash")?.action).toBe("resolve");
    expect(out.get("new")?.action).toBe("create");
  });

  it("orders about 10 steps: money conflicts, money pages to improve, new top pages, then support", () => {
    const out = planFirst([
      root,
      page("support", { money: false, value: 0.9, volume: 90000 }),
      page("new-sell", { value: 0.8 }),
      page("improve", { existing: "weak", value: 0.2 }),
      page("clash", { existing: "covered", conflict: true, value: 0.1 }),
      page("other-offer", { top: false, value: 1, volume: 50000 }),
      page("article-clash", { existing: "covered", conflict: true, money: false, top: false }),
    ]);
    const steps = [...out.entries()]
      .filter(([, a]) => a.wave === "now")
      .sort((a, b) => (a[1].step ?? 0) - (b[1].step ?? 0))
      .map(([id]) => id);
    expect(steps).toEqual(["clash", "improve", "new-sell", "support"]);
    // Work for an offering that isn't top waits, however big its search.
    expect(out.get("other-offer")?.wave).toBe("later");
    expect(out.get("article-clash")?.wave).toBe("later");
    expect(out.get("clash")).toMatchObject({ step: 1, priority: 1 });
  });

  it("stops at the plan size and brings a new page's new hub along", () => {
    const out = planFirst(
      [
        root,
        page("hub", { value: 0.01 }),
        page("child", { parentId: "hub", value: 0.9 }),
        ...Array.from({ length: 20 }, (_, i) => page(`p${i}`, { value: 0.5 - i / 100 })),
      ],
      { size: 4, max: 5 },
    );
    const now = [...out.values()].filter((a) => a.wave === "now");
    expect(now).toHaveLength(4);
    expect(out.get("hub")?.wave).toBe("now");
    expect(out.get("child")?.wave).toBe("now");
    expect([...out.values()].filter((a) => a.wave === "later").every((a) => a.priority >= 4)).toBe(
      true,
    );
  });

  it("leaves a page out of the plan when its new hub serves no top offering", () => {
    const out = planFirst([
      root,
      page("hub", { top: false }),
      page("child", { parentId: "hub", value: 0.9 }),
    ]);
    expect(out.get("child")?.wave).toBe("later");
  });
});
