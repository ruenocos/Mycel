import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClientContext, GateExpectations, SitePages } from "./index.ts";

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
