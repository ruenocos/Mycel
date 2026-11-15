import { describe, expect, it } from "vitest";
import { pageInventory } from "./inventory.ts";

const p = (url: string, kind: string, title: string, extra: { category?: string } = {}) =>
  ({ url, kind, title, h1: title, ...extra }) as never;

describe("pageInventory", () => {
  it("gives every existing page a job: serves, competes, supports or outside", () => {
    const pages = [
      p("/", "home", "Home"),
      p("/grote-planten/", "category", "Grote planten"),
      p("/xl/", "category", "XL planten"),
      p("/product/ficus/", "product", "Ficus kopen", { category: "Grote planten" }),
      p("/blog/verpotten/", "blog", "Kamerplant verpotten"),
      p("/team/", "other", "Ons team"),
      p("/contact/", "contact", "Contact"),
    ];
    const scores = new Map([["/blog/verpotten/", new Map([["care", { score: 0.6, h1: 0.5 }]])]]);
    const inv = pageInventory({
      nodes: [
        { id: "root", isRoot: true, section: "core", pages: ["/"], conflict: [] },
        {
          id: "big",
          isRoot: false,
          section: "core",
          name: "Grote planten",
          pages: ["/grote-planten/"],
          conflict: ["/grote-planten/", "/xl/"],
        },
        {
          id: "care",
          isRoot: false,
          section: "outer",
          name: "Verzorging",
          pages: [],
          conflict: [],
        },
      ],
      pages,
      scores,
      language: "nl",
      title: (x) => x.title,
    });
    const job = (url: string) => inv.find((e) => e.url === url);
    expect(job("/grote-planten/")).toMatchObject({ job: "serves", nodeId: "big" });
    expect(job("/xl/")).toMatchObject({ job: "competes", nodeId: "big" });
    expect(job("/product/ficus/")).toMatchObject({ job: "supports", nodeId: "big" });
    expect(job("/blog/verpotten/")).toMatchObject({ job: "supports", nodeId: "care" });
    expect(job("/team/")).toMatchObject({ job: "outside" });
    expect(job("/contact/")).toBeUndefined();
    expect(job("/")).toBeUndefined();
  });
});
