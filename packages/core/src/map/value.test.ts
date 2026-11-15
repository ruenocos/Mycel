import { BusinessProfile } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import { byValue, pageValue, stageOf, tierOf, topOfferings } from "./value.ts";

const offering = (id: string, value: "top" | "normal" | "side") => ({
  id,
  name: id,
  kind: "service" as const,
  value,
  sources: [{ from: "owner" as const }],
});

describe("value", () => {
  it("weighs tier x stage x click price x opportunity, with volume only as a tie-break", () => {
    const sell = pageValue({ tier: "top", intent: "transactional", existing: false, seen: false });
    const learn = pageValue({ tier: "top", intent: "informational", existing: false, seen: false });
    const side = pageValue({ tier: "side", intent: "transactional", existing: false, seen: false });
    const quickWin = pageValue({
      tier: "top",
      intent: "transactional",
      existing: true,
      seen: true,
    });
    const pricey = pageValue({
      tier: "top",
      intent: "transactional",
      cpc: 3,
      existing: false,
      seen: false,
    });
    expect(sell).toBeGreaterThan(learn);
    expect(sell).toBeGreaterThan(side);
    expect(quickWin).toBeGreaterThan(sell);
    expect(pricey).toBeGreaterThan(sell);
    expect(stageOf("local")).toBe("buy");
    expect(stageOf("commercial")).toBe("compare");
    const pages = [
      { id: "big-question", value: learn, volume: 50000 },
      { id: "small-sale", value: sell, volume: 20 },
      { id: "tie-a", value: sell, volume: 30 },
    ].sort(byValue);
    expect(pages.map((p) => p.id)).toEqual(["tie-a", "small-sale", "big-question"]);
  });

  it("reads tiers from the profile and picks at most three top offerings", () => {
    const b = BusinessProfile.parse({
      offerings: ["a", "b", "c", "d"]
        .map((id) => offering(id, "top"))
        .concat(offering("e", "side")),
    });
    expect(tierOf(b, "e", "core")).toBe("side");
    expect(tierOf(b, undefined, "core")).toBe("none");
    expect(tierOf(undefined, undefined, "core")).toBe("top");
    const demand = new Map([
      ["a", 10],
      ["b", 500],
      ["c", 300],
      ["d", 200],
    ]);
    expect([...topOfferings(b, demand)].sort()).toEqual(["b", "c", "d"]);
    const none = BusinessProfile.parse({
      offerings: [offering("x", "normal"), offering("y", "normal")],
    });
    expect([...topOfferings(none, new Map([["y", 5]]))]).toEqual(["y", "x"]);
  });
});
