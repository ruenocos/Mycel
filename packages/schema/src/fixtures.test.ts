import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClientContext, FilterEvalSet, GateExpectations, SitePages } from "./index.ts";

const root = join(import.meta.dirname, "../../../fixtures/clients");
const load = (client: string, file: string): unknown =>
  JSON.parse(readFileSync(join(root, client, file), "utf8"));

const clients = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

describe("test-client fixtures", () => {
  it("has both test clients", () => {
    expect(clients).toEqual(expect.arrayContaining(["plantpost", "praktijk-beweegruimte"]));
  });

  describe.each(clients)("%s", (client) => {
    const context = ClientContext.parse(load(client, "context.json"));
    const pages = SitePages.parse(load(client, "pages.json"));
    const gate = GateExpectations.parse(load(client, "expectations.json"));
    const urls = new Set(pages.pages.map((p) => p.url));

    it("matches the site in context and pages", () => {
      expect(new URL(context.site.url).hostname).toBe(pages.site);
    });

    it("plants a conflict between two existing pages", () => {
      const [a, b] = gate.plantedConflict.urls;
      expect(a).not.toBe(b);
      expect(urls.has(a)).toBe(true);
      expect(urls.has(b)).toBe(true);
    });

    it("labels the gate's core, outer and off-topic queries the same way in the filter eval", () => {
      const set = FilterEvalSet.parse(load(client, "filter-eval.json"));
      expect(set.client).toBe(client);
      const label = new Map(set.cases.map((c) => [c.query, c.expect]));
      for (const q of [...gate.expectedCore, ...gate.expectedOuter]) {
        if (label.has(q)) expect(label.get(q), q).toBe("keep");
      }
      for (const q of gate.offTopic) if (label.has(q)) expect(label.get(q), q).toBe("drop");
      expect(set.cases.filter((c) => c.expect === "drop").length).toBeGreaterThanOrEqual(8);
    });

    it("has a held-out filter set that shares no query with the tuning set", () => {
      const tuning = FilterEvalSet.parse(load(client, "filter-eval.json"));
      const heldOut = FilterEvalSet.parse(load(client, "filter-holdout.json"));
      expect(heldOut.client).toBe(client);
      const fold = (q: string) => q.toLowerCase().trim();
      const seen = new Set(tuning.cases.map((c) => fold(c.query)));
      expect(heldOut.cases.filter((c) => seen.has(fold(c.query)))).toEqual([]);
      expect(new Set(heldOut.cases.map((c) => fold(c.query))).size).toBe(heldOut.cases.length);
      expect(heldOut.cases.length).toBeGreaterThanOrEqual(25);
      expect(heldOut.cases.filter((c) => c.expect === "drop").length).toBeGreaterThanOrEqual(8);
    });

    it("keeps off-topic terms out of the offerings", () => {
      const offered = context.offerings.join(" ").toLowerCase();
      for (const term of gate.offTopic) expect(offered).not.toContain(term);
    });

    it("is not confirmed until a human approves it", () => {
      expect(context.confirmed).toBeUndefined();
    });
  });

  it("sets a city only for the local client", () => {
    const plant = ClientContext.parse(load("plantpost", "context.json"));
    const physio = ClientContext.parse(load("praktijk-beweegruimte", "context.json"));
    expect(plant.market.city).toBeUndefined();
    expect(physio.market.city).toBe("Utrecht");
  });
});
