import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BusinessProfile, type SitePage } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import {
  applyOwnerAnswers,
  type BusinessProposal,
  buildBusinessEvidence,
  buildBusinessMessages,
  scoreProfile,
  simulateOwner,
  toBusinessProfile,
  unknownFields,
} from "./business.ts";

const fixture = (name: string) => join(import.meta.dirname, "../../../../fixtures/clients", name);
const pages = (name: string): SitePage[] =>
  JSON.parse(readFileSync(join(fixture(name), "pages.json"), "utf8")).pages;
const key = (name: string) => {
  const { $comment: _c, ...rest } = JSON.parse(
    readFileSync(join(fixture(name), "business.key.json"), "utf8"),
  );
  return BusinessProfile.parse(rest);
};

const ctx = {
  site: { url: "https://praktijkbeweegruimte.example", name: "Praktijk Beweegruimte" },
  market: { country: "NL", language: "nl", city: "Utrecht" },
  sourceContext: "Fysiotherapiepraktijk in Utrecht.",
  offerings: ["fysiotherapie", "dry needling", "kinesiotaping"],
};

const proposal = (over: Partial<BusinessProposal> = {}): BusinessProposal => ({
  offerings: [
    {
      name: "dry needling",
      kind: "service",
      page: "/behandelingen/dry-needling/",
      subOfferings: [],
      attributes: [],
      audiences: [],
      places: [],
      proofPoints: [],
      value: "normal",
      evidence: ["page:/behandelingen/dry-needling/"],
    },
    {
      name: "fysiotherapie",
      kind: "service",
      subOfferings: ["algemene fysiotherapie"],
      attributes: [],
      audiences: ["volwassenen"],
      places: [],
      proofPoints: [],
      value: "top",
      evidence: ["page:/behandelingen/fysiotherapie/", "page:/nergens/"],
    },
    {
      name: "kaakfysiotherapie",
      kind: "service",
      subOfferings: [],
      attributes: [],
      audiences: [],
      places: [],
      proofPoints: [],
      value: "normal",
      evidence: ["competitor:kaakfysiotherapie utrecht"],
    },
  ],
  notOffered: [
    { name: "kinderfysiotherapie", aliases: [], evidence: ["page:/over-ons/"] },
    { name: "oncologie", aliases: [], evidence: [] },
  ],
  locations: [
    {
      name: "Lombok",
      city: "Utrecht",
      page: "/locaties/lombok/",
      evidence: ["page:/locaties/lombok/"],
    },
  ],
  serves: [],
  nationwide: false,
  differentiators: [],
  facts: [{ fact: "Team van acht fysiotherapeuten", evidence: ["page:/"] }],
  brand: { own: ["Beweegruimte"], neverTarget: [] },
  siteTerms: [],
  openQuestions: [],
  ...over,
});

describe("business profile", () => {
  const evidence = buildBusinessEvidence(ctx, pages("praktijk-beweegruimte"), [
    {
      text: "kaakfysiotherapie utrecht",
      normalized: "kaakfysiotherapie utrecht",
      sources: ["dfs_ranked_competitor"],
      metrics: { volume: 90 },
    },
  ]);

  it("builds evidence with offer pages first and competitor searches apart", () => {
    expect(evidence.pages[0]?.kind).toBe("home");
    expect(evidence.articles.length).toBe(3);
    expect(evidence.competitor.map((q) => q.id)).toEqual(["competitor:kaakfysiotherapie utrecht"]);
    const user = buildBusinessMessages(evidence, ctx).at(-1)?.content ?? "";
    expect(user).toContain("SEARCHES ONLY COMPETITORS RANK FOR");
  });

  it("keeps only what has proof: competitor searches become questions, guesses are dropped", () => {
    const { profile, removed } = toBusinessProfile(proposal(), evidence, ctx);
    expect(profile.offerings.map((o) => o.id)).toEqual(["dry-needling", "fysiotherapie"]);
    const dn = profile.offerings[0];
    expect(dn?.sources[0]).toMatchObject({ from: "site", confidence: "high" });
    expect(dn?.unknown).toEqual(["attributes", "audiences", "priceRange", "proofPoints"]);
    expect(profile.notOffered.map((n) => n.name)).toEqual(["kinderfysiotherapie"]);
    expect(profile.openQuestions).toContain('Do you offer "kaakfysiotherapie"?');
    // An offering the owner named earlier that the site doesn't show is asked, not dropped.
    expect(profile.openQuestions).toContain('Do you offer "kinesiotaping"?');
    expect(removed.join("\n")).toContain("a competitor search is not proof");
    expect(removed.join("\n")).toContain('unknown evidence "page:/nergens/"');
  });

  it("applies the owner's answers: removals become no-go, edits fill unknowns, top is set", () => {
    const { profile } = toBusinessProfile(proposal(), evidence, ctx);
    const done = applyOwnerAnswers(profile, {
      by: "Wons",
      at: "2026-11-15T10:00:00.000Z",
      removed: ["dry-needling"],
      edits: [{ id: "fysiotherapie", set: { priceRange: "vergoed via aanvullende verzekering" } }],
      added: [{ id: "medische-fitness", name: "medische fitness" }],
      top: ["medische-fitness"],
      notOffered: [{ name: "huisbezoeken", aliases: [] }],
      facts: [],
    });
    expect(done.confirmed?.by).toBe("Wons");
    expect(done.offerings.map((o) => [o.id, o.value, o.status])).toEqual([
      ["fysiotherapie", "normal", "edited"],
      ["medische-fitness", "top", "added"],
    ]);
    expect(done.offerings[0]?.unknown).not.toContain("priceRange");
    expect(done.notOffered.map((n) => n.name)).toEqual([
      "kinderfysiotherapie",
      "dry needling",
      "huisbezoeken",
    ]);
    expect(done.openQuestions).toEqual([]);
  });

  it("scores against the answer key, and a simulated owner closes the gap", () => {
    const k = key("praktijk-beweegruimte");
    const { profile } = toBusinessProfile(proposal(), evidence, ctx);
    const before = scoreProfile(profile, k, "nl");
    expect(before.offerings.recall).toBeCloseTo(2 / 6, 2);
    expect(before.offerings.missed).toContain("sportfysiotherapie");
    expect(before.notOffered.recall).toBe(0.5);
    const answers = simulateOwner(profile, k, "nl");
    const after = scoreProfile(applyOwnerAnswers(profile, answers), k, "nl");
    expect(after.offerings.recall).toBe(1);
    expect(after.offerings.precision).toBe(1);
    expect(after.notOffered.recall).toBe(1);
    expect(after.places.recall).toBe(1);
  });

  it("asks only the fields that are empty", () => {
    expect(
      unknownFields({
        subOfferings: [],
        attributes: [{ name: "maat", values: ["groot"] }],
        audiences: [],
        places: [],
        proofPoints: ["10 jaar garantie"],
      }),
    ).toEqual(["audiences", "priceRange"]);
  });

  it("the three answer keys are valid profiles with a no-go list", () => {
    for (const c of ["plantpost", "praktijk-beweegruimte", "dakwerken-maasstad"]) {
      const k = key(c);
      expect(k.offerings.length).toBeGreaterThan(4);
      expect(k.notOffered.length).toBeGreaterThan(1);
    }
  });
});
