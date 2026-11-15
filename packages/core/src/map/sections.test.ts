import { BusinessProfile, type SiteSection } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import { assignSections, type SectionNode, siteSections, TOP_LEVEL } from "./sections.ts";
import { proposeUrls } from "./urls.ts";

const page = (url: string, kind: string, h1 = url, extra: Record<string, string> = {}) =>
  ({ url, kind, title: h1, h1, ...extra }) as never;

const offering = (id: string, kind: "service" | "product_line", page?: string) => ({
  id,
  name: id,
  kind,
  ...(page ? { page } : {}),
  subOfferings: [],
  attributes: [],
  audiences: [],
  places: [],
  proofPoints: [],
  value: "normal" as const,
  sources: [{ from: "site" as const, confidence: "high" as const }],
  unknown: [],
  status: "confirmed" as const,
});

const business = (over: Partial<BusinessProfile> = {}): BusinessProfile =>
  BusinessProfile.parse({
    offerings: [offering("erp", "service", "/oplossingen/erp/")],
    places: { nationwide: true },
    ...over,
  });

describe("siteSections", () => {
  it("keeps the reader's post types, then menu groups for root pages, then folders", () => {
    const sections: SiteSection[] = [
      { key: "page", name: "Pagina's", folder: "/", source: "post_type", categories: [] },
      { key: "post", name: "Berichten", folder: "/blog/", source: "post_type", categories: [] },
    ];
    const pages = [
      page("/", "home"),
      page("/dakreparatie/", "service", "Dakreparatie", { section: "page" }),
      page("/dakgoten/", "service", "Dakgoten", { section: "page" }),
      page("/plat-dak/", "service", "Plat dak", { section: "page" }),
      page("/plat-dak/epdm/", "service", "EPDM", { section: "page" }),
      page("/over-ons/", "about", "Over ons", { section: "page" }),
      page("/blog/a/", "blog", "A", { section: "post", category: "Tips" }),
      page("/werkgebied/rotterdam/", "location", "Dakdekker Rotterdam"),
      page("/werkgebied/schiedam/", "location", "Dakdekker Schiedam"),
      page("/kosten/", "pricing", "Kosten"),
    ];
    const menu = [
      { label: "Diensten", urls: ["/dakreparatie/", "/dakgoten/", "/plat-dak/"] },
      { label: "Blog", urls: ["/blog/a/"] },
    ];
    const r = siteSections({ pages, sections, menu, language: "nl" });
    const keyOf = (url: string) => r.pageSection.get(url)?.key;
    expect(keyOf("/dakreparatie/")).toBe("diensten");
    expect(keyOf("/plat-dak/epdm/")).toBe("diensten");
    expect(keyOf("/over-ons/")).toBe("page");
    expect(r.pageSection.get("/blog/a/")).toEqual({ key: "post", category: "Tips" });
    expect(keyOf("/werkgebied/schiedam/")).toBe("werkgebied");
    expect(keyOf("/kosten/")).toBe(TOP_LEVEL);
    const role = (key: string) => r.sections.find((s) => s.key === key)?.role;
    expect(r.sections.find((s) => s.key === "diensten")).toMatchObject({
      name: "Diensten",
      folder: "/",
      source: "menu",
      role: "offer",
    });
    expect(r.sections.find((s) => s.key === "werkgebied")).toMatchObject({
      name: "Werkgebied",
      folder: "/werkgebied/",
      role: "place",
    });
    expect(role("post")).toBe("knowledge");
    expect(role("page")).toBe("company");
    expect(role(TOP_LEVEL)).toBeUndefined();
  });

  it("guesses roles from the business: offering pages, audiences, places; the owner overrides", () => {
    const b = business({
      offerings: [
        { ...offering("erp", "service", "/oplossingen/erp/"), audiences: ["bouwbedrijven"] },
        offering("planner", "product_line", "/extensies/planner/"),
      ],
      siteSections: [
        { key: "klanten", role: "proof", ignore: false },
        { key: "diensten", ignore: true },
      ],
    });
    const pages = [
      page("/oplossingen/erp/", "other", "ERP"),
      page("/oplossingen/apps/", "other", "Apps"),
      page("/extensies/planner/", "other", "Planner"),
      page("/extensies/dms/", "other", "DMS"),
      page("/sectoren/bouwbedrijven/", "other", "ERP voor bouwbedrijven"),
      page("/sectoren/bouw/", "other", "Bouwbedrijven"),
      page("/klanten/acme/", "other", "Acme"),
      page("/klanten/beta/", "other", "Beta"),
      page("/diensten/test/", "other", "Test"),
      page("/diensten/test2/", "other", "Test 2"),
    ];
    const r = siteSections({ pages, business: b, language: "nl" });
    const role = (key: string) => r.sections.find((s) => s.key === key)?.role;
    expect(role("oplossingen")).toBe("offer");
    expect(role("extensies")).toBe("product");
    expect(role("sectoren")).toBe("audience");
    expect(role("klanten")).toBe("proof");
    expect(role("diensten")).toBeUndefined();
  });
});

describe("assignSections", () => {
  const sections: SiteSection[] = [
    {
      key: "oplossingen",
      name: "Oplossingen",
      folder: "/oplossingen/",
      source: "post_type",
      role: "offer",
      categories: [],
    },
    {
      key: "sectoren",
      name: "Sectoren",
      folder: "/sectoren/",
      source: "post_type",
      role: "audience",
      categories: [],
    },
    {
      key: "post",
      name: "Kennisbank",
      folder: "/kennisbank/",
      source: "post_type",
      role: "knowledge",
      categories: [
        { name: "Business Central", folder: "/kennisbank/business-central/" },
        { name: "AI", folder: "/kennisbank/ai/" },
      ],
    },
  ];
  const site = {
    sections,
    pageSection: new Map([
      ["/oplossingen/erp/", { key: "oplossingen" }],
      ["/sectoren/bouw/", { key: "sectoren" }],
      ["/kennisbank/business-central/x/", { key: "post", category: "Business Central" }],
    ]),
  };
  const n = (id: string, over: Partial<SectionNode> = {}): SectionNode => ({
    id,
    isRoot: false,
    tier: "core",
    intent: "commercial",
    mainQuery: id,
    ...over,
  });
  const b = business({
    offerings: [
      { ...offering("erp", "service", "/oplossingen/erp/"), audiences: ["bouwbedrijven"] },
      offering("planner", "product_line"),
    ],
  });

  it("places every page by the rules, and suggests a section the site lacks", () => {
    const nodes = [
      n("root", { isRoot: true }),
      n("erp", { hub: "offering", offeringId: "erp", existing: "/oplossingen/erp/" }),
      n("erp voor bouwbedrijven", { offeringId: "erp" }),
      n("wat is business central", {
        tier: "outer",
        intent: "informational",
        name: "Business Central uitgelegd",
      }),
      n("erp koppeling", { offeringId: "erp" }),
      n("planner", { hub: "offering", offeringId: "planner" }),
      n("erp leverancier rotterdam", { intent: "local" }),
      n("erp leverancier delft", { intent: "local" }),
      n("erp leverancier gouda", { intent: "local" }),
    ];
    const parent = new Map(nodes.filter((x) => !x.isRoot).map((x) => [x.id, "root"]));
    parent.set("erp koppeling", "erp");
    const { of, suggested } = assignSections({ nodes, parent, site, business: b, language: "nl" });
    expect(of.get("erp")).toMatchObject({ key: "oplossingen", why: "existing page" });
    expect(of.get("erp voor bouwbedrijven")?.key).toBe("sectoren");
    expect(of.get("wat is business central")).toMatchObject({
      key: "post",
      category: "Business Central",
    });
    expect(of.get("erp koppeling")?.key).toBe("oplossingen");
    // No product section on this site: the offer section takes it.
    expect(of.get("planner")?.key).toBe("oplossingen");
    expect(of.get("erp leverancier rotterdam")).toMatchObject({
      key: "suggested-place",
      suggested: true,
    });
    expect(suggested.map((s) => s.role)).toEqual(["place"]);
    // One local page alone is no reason for a new section.
    const one = assignSections({
      nodes: nodes.filter((x) => !x.id.endsWith("delft") && !x.id.endsWith("gouda")),
      parent,
      site,
      business: b,
      language: "nl",
    });
    expect(one.suggested).toEqual([]);
    expect(one.of.get("erp leverancier rotterdam")?.key).toBe("oplossingen");
    expect(of.has("root")).toBe(false);
  });

  it("gives new pages URLs inside their section's folder", () => {
    const urls = proposeUrls({
      nodes: [
        { id: "root", isRoot: true, section: "core", informational: false, mainQuery: "erp" },
        {
          id: "a",
          isRoot: false,
          section: "outer",
          informational: true,
          mainQuery: "wat is business central",
          folder: "/kennisbank/business-central/",
        },
        {
          id: "b",
          isRoot: false,
          section: "core",
          informational: false,
          mainQuery: "erp voor de bouw",
          folder: "/sectoren/",
        },
        {
          id: "c",
          isRoot: false,
          section: "outer",
          informational: false,
          mainQuery: "dakgoot reparatie",
          existing: "/dakgoten/",
          folder: "/",
        },
        {
          id: "d",
          isRoot: false,
          section: "outer",
          informational: false,
          mainQuery: "zinken dakgoot",
          folder: "/",
        },
      ],
      parent: new Map([
        ["a", "root"],
        ["b", "root"],
        ["c", "root"],
        ["d", "c"],
      ]),
      pages: [],
    });
    expect(urls.get("a")).toBe("/kennisbank/business-central/wat-is-business-central/");
    expect(urls.get("b")).toBe("/sectoren/erp-voor-de-bouw/");
    expect(urls.get("d")).toBe("/dakgoten/zinken-dakgoot/");
  });
});
