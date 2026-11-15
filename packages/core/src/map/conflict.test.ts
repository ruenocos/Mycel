import { describe, expect, it } from "vitest";
import { wordRivals } from "./conflict.ts";

describe("wordRivals", () => {
  it("finds a page whose words fully match another page's search, but not for hubs", () => {
    const scores = new Map([
      [
        "/prijzen/",
        new Map([
          ["costs", { score: 1, h1: 0.6 }],
          ["hub", { score: 1, h1: 0.9 }],
        ]),
      ],
      ["/blog/kosten/", new Map([["costs", { score: 1, h1: 1 }]])],
      ["/blog/vaag/", new Map([["costs", { score: 0.6, h1: 0.6 }]])],
    ]);
    const rivals = wordRivals({
      nodes: [
        { id: "root", isRoot: true, hub: false, page: "/" },
        { id: "costs", isRoot: false, hub: false, page: "/blog/kosten/" },
        { id: "hub", isRoot: false, hub: true, page: "/dienst/" },
      ],
      scores,
    });
    expect(rivals.get("costs")).toEqual(["/prijzen/"]);
    expect(rivals.has("hub")).toBe(false);
  });
});
