import { describe, expect, it } from "vitest";
import { type ActionInput, planActions } from "./actions.ts";

const page = (id: string, over: Partial<ActionInput> = {}): ActionInput => ({
  id,
  isRoot: false,
  parentId: "root",
  existing: null,
  conflict: false,
  score: 0.5,
  ...over,
});

describe("planActions", () => {
  it("gives each page what to do: keep, improve, resolve or create", () => {
    const out = planActions([
      page("root", { isRoot: true, existing: "covered" }),
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

  it("cuts the work into a first plan: conflicts first, then value; the rest later", () => {
    const nodes = [
      page("root", { isRoot: true, existing: "covered" }),
      ...Array.from({ length: 50 }, (_, i) => page(`new${i}`, { score: 1 - i / 100 })),
      page("clash", { existing: "covered", conflict: true, score: 0.01 }),
    ];
    const out = planActions(nodes, { size: 10, max: 15 });
    const now = [...out.entries()].filter(([, a]) => a.wave === "now");
    expect(now).toHaveLength(10);
    expect(out.get("clash")).toMatchObject({ wave: "now", priority: 1 });
    expect(out.get("new0")?.wave).toBe("now");
    expect(out.get("new49")).toMatchObject({ wave: "later", priority: 5 });
    expect(now.every(([, a]) => a.priority <= 3)).toBe(true);
    expect([...out.values()].filter((a) => a.wave === "later").every((a) => a.priority >= 4)).toBe(
      true,
    );
  });

  it("brings a new page's new hub into the plan with it", () => {
    const out = planActions(
      [
        page("root", { isRoot: true, existing: "covered" }),
        page("hub", { score: 0.01 }),
        page("child", { parentId: "hub", score: 0.9 }),
        page("other", { score: 0.5 }),
      ],
      { size: 2, max: 3 },
    );
    expect(out.get("child")?.wave).toBe("now");
    expect(out.get("hub")?.wave).toBe("now");
    expect(out.get("other")?.wave).toBe("later");
  });

  it("weighs improving an existing page over writing a new one of equal value", () => {
    const out = planActions(
      [
        page("root", { isRoot: true, existing: "covered" }),
        page("new", { score: 0.5 }),
        page("weak", { existing: "weak", score: 0.4 }),
      ],
      { size: 1, max: 1 },
    );
    expect(out.get("weak")?.wave).toBe("now");
    expect(out.get("new")?.wave).toBe("later");
  });
});
