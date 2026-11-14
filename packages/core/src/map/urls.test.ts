import { describe, expect, it } from "vitest";
import { proposeUrls, type UrlNode } from "./urls.ts";

const n = (id: string, over: Partial<UrlNode> = {}): UrlNode => ({
  id,
  isRoot: false,
  section: "outer",
  informational: false,
  mainQuery: id.replace(/-/g, " "),
  ...over,
});

describe("proposeUrls", () => {
  const pages = [
    { url: "/", kind: "home" },
    { url: "/kennisbank/erp-kiezen/", kind: "blog" },
    { url: "/kennisbank/btw-boeken/", kind: "blog" },
    { url: "/kennisbank/dms-uitleg/", kind: "blog" },
    { url: "/sectoren/bouw/", kind: "category" },
    { url: "/sectoren/handel/", kind: "category" },
  ];

  it("keeps existing URLs, puts new articles in the article folder and new sectors next to theirs", () => {
    const nodes = [
      n("root", { isRoot: true, existing: "/" }),
      n("bouw", { section: "core", existing: "/sectoren/bouw/" }),
      n("handel", { section: "core", existing: "/sectoren/handel/" }),
      n("installatie", { section: "core" }),
      n("wat-is-erp", { informational: true }),
    ];
    const parent = new Map([
      ["bouw", "root"],
      ["handel", "root"],
      ["installatie", "root"],
      ["wat-is-erp", "root"],
    ]);
    const urls = proposeUrls({ nodes, parent, pages });
    expect(urls.get("bouw")).toBe("/sectoren/bouw/");
    expect(urls.get("installatie")).toBe("/sectoren/installatie/");
    expect(urls.get("wat-is-erp")).toBe("/kennisbank/wat-is-erp/");
  });

  it("nests a new supporting page under its hub's path, two folders deep at most", () => {
    const nodes = [
      n("root", { isRoot: true, existing: "/" }),
      n("hub", { section: "core", existing: "/kamerplanten/grote-kamerplanten/" }),
      n("grote-monstera", { informational: false }),
    ];
    const parent = new Map([
      ["hub", "root"],
      ["grote-monstera", "hub"],
    ]);
    const urls = proposeUrls({ nodes, parent, pages: [{ url: "/", kind: "home" }] });
    expect(urls.get("grote-monstera")).toBe("/kamerplanten/grote-kamerplanten/grote-monstera/");
  });

  it("never reuses an existing page's URL for a new page", () => {
    const nodes = [n("root", { isRoot: true }), n("bouw", { section: "core" })];
    const urls = proposeUrls({
      nodes,
      parent: new Map([["bouw", "root"]]),
      pages: [{ url: "/bouw/", kind: "other" }],
    });
    expect(urls.get("bouw")).toBe("/bouw-2/");
  });
});
