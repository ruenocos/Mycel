import { BusinessProfile } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import { type ClaimFacts, checkText, plainName, plainWhy, signalWhy } from "./check.ts";

const business = BusinessProfile.parse({
  offerings: [
    {
      id: "dakreparatie",
      name: "Dakreparatie",
      kind: "service",
      priceRange: "vanaf € 95",
      sources: [{ from: "owner" }],
    },
  ],
  notOffered: [{ name: "dakkapellen", aliases: ["dakkapel"], sources: [{ from: "owner" }] }],
  places: {
    locations: [{ name: "Kralingen", city: "Rotterdam" }],
    serves: ["Rotterdam", "Schiedam"],
    nationwide: false,
  },
  facts: [{ fact: "Tien jaar garantie op nieuwe daken", sources: [{ from: "owner" }] }],
  brand: { neverTarget: ["Dakbeheer BV"] },
});
const facts = (searches: string[] = []): ClaimFacts => ({
  language: "nl",
  country: "NL",
  city: "Rotterdam",
  siteName: "Dakwerken",
  business,
  searches,
});

describe("checkText", () => {
  it("passes a plain text that claims only what the profile holds", () => {
    expect(
      checkText("Veel mensen in Schiedam zoeken een dakdekker; reparatie vanaf € 95.", facts()),
    ).toEqual([]);
    expect(checkText("Dakdekker in Delft", facts(["dakdekker delft"]))).toEqual([]);
  });

  it("flags praise, jargon, prices, places and services the profile doesn't hold", () => {
    expect(checkText("De beste dakdekker van de regio.", facts())).toEqual([
      'unproven praise "beste"',
    ]);
    expect(checkText("Een kernpagina met koopintentie.", facts())[0]).toContain("jargon");
    expect(checkText("Reparatie voor € 49.", facts())).toEqual(["price 49 not in the profile"]);
    expect(checkText("Wij plaatsen ook een dakkapel.", facts())).toEqual([
      '"dakkapellen" is not offered',
    ]);
    expect(checkText("Bezoek onze vestiging in Delft.", facts())).toContain(
      'claims an own location in "Delft"',
    );
    expect(checkText("Snel geholpen in Gouda.", facts())).toEqual([
      'names "Gouda", a place not served',
    ]);
  });

  it("checks no places for a nationwide business", () => {
    const nationwide = BusinessProfile.parse({ ...business, places: { nationwide: true } });
    expect(checkText("Bezorgd in Groningen.", { ...facts(), business: nationwide })).toEqual([]);
  });
});

describe("plain fallbacks", () => {
  it("writes a why and a name from data in the market language", () => {
    const n = {
      mainQuery: "daklekkage repareren",
      volume: 1200,
      intent: { main: "transactional" as const, mixed: false, source: "data" as const },
    };
    expect(plainWhy(n, "nl", "Dakreparatie")).toBe(
      'Op "daklekkage repareren" wordt ongeveer 1.200 keer per maand gezocht door mensen die willen kopen of boeken. De pagina hoort bij Dakreparatie.',
    );
    expect(plainWhy({ ...n, hub: "offering" as const }, "en")).toContain("offerings");
    expect(plainName("daklekkage repareren")).toBe("Daklekkage repareren");
  });
});

describe("signal sentences", () => {
  it("says a big rise as a multiple, which passes the claim check", () => {
    const rise = (change: number) =>
      signalWhy({ trend: { label: "rising", change, peakMonths: [] } }, "nl");
    expect(rise(0.42)).toBe("Er wordt 42% meer op gezocht dan een jaar eerder.");
    expect(rise(1)).toBe("Er wordt twee keer zo vaak op gezocht als een jaar eerder.");
    expect(rise(13)).toBe("Er wordt 14 keer zo vaak op gezocht als een jaar eerder.");
    expect(rise(2.3)).toBe("Er wordt ruim 3 keer zo vaak op gezocht als een jaar eerder.");
    const facts: ClaimFacts = { language: "nl", country: "NL", siteName: "X", searches: [] };
    expect(checkText(rise(1), facts)).toEqual([]);
  });
});
