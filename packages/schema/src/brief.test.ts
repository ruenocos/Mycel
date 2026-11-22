import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRIEF_VERSION, Brief } from "./index.ts";

// Synthetic fixture (Plantpost is a fictional test client), so it may live in the repo.
const fixture = join(import.meta.dirname, "../../../fixtures/clients/plantpost/brief.json");
const load = () => JSON.parse(readFileSync(fixture, "utf8"));
const messages = (raw: unknown) =>
  Brief.safeParse(raw)
    .error?.issues.map((i) => i.message)
    .join("\n") ?? "";

describe("Brief", () => {
  it("reads the test client's brief", () => {
    const b = Brief.parse(load());
    expect(b.version).toBe(BRIEF_VERSION);
    expect(b.outline[0]?.level).toBe("h1");
    expect(b.targets.headings).toBe(4);
    expect(b.evidence.map((e) => e.check.state)).toEqual([
      "checked",
      "unchecked",
      "unchecked",
      "unchecked",
    ]);
    expect(b.evidence[1]?.source).toMatchObject({ kind: "url", url: "https://plantpost.example/" });
    expect(b.research.createdAt).toBe("2026-11-20T09:40:00.000Z");
  });

  it("refuses another version: a reader checks the marker before the rest", () => {
    expect(Brief.safeParse({ ...load(), version: 1 }).success).toBe(false);
    expect(Brief.safeParse({ ...load(), version: undefined }).success).toBe(false);
  });

  it("fills in what Mycel leaves out: an unchecked fact, empty lists", () => {
    const raw = load();
    delete raw.evidence[1].check;
    for (const key of ["avoid", "questions", "links", "terms", "warnings"]) delete raw[key];
    const b = Brief.parse(raw);
    expect(b.evidence[1]?.check).toEqual({ state: "unchecked" });
    expect(b.avoid).toEqual([]);
    expect(b.links).toEqual([]);
  });

  it("needs a person and a time on a checked fact, and a real source", () => {
    const raw = load();
    raw.evidence[0].check = { state: "checked" };
    expect(Brief.safeParse(raw).success).toBe(false);
    const noUrl = load();
    noUrl.evidence[1].source = { kind: "url", url: "not a url" };
    expect(Brief.safeParse(noUrl).success).toBe(false);
    const noRef = load();
    noRef.evidence[0].source = { kind: "business" };
    expect(Brief.safeParse(noRef).success).toBe(false);
  });

  it("keeps the outline in shape: one H1 first, H3s under an H2", () => {
    const noH1 = load();
    noH1.outline[0].level = "h2";
    noH1.targets.headings = 5;
    expect(messages(noH1)).toMatch(/starts with the H1/);

    const twoH1 = load();
    twoH1.outline[3].level = "h1";
    twoH1.targets.headings = 3;
    expect(messages(twoH1)).toMatch(/one H1/);

    const loneH3 = load();
    loneH3.outline[1].level = "h3";
    expect(messages(loneH3)).toMatch(/H3 comes under an H2/);
  });

  it("points only at evidence it has, and counts its headings", () => {
    const raw = load();
    raw.outline[1].evidence.push("e9");
    raw.evidence.push({ ...raw.evidence[0] });
    raw.targets.headings = 7;
    const text = messages(raw);
    expect(text).toMatch(/unknown evidence e9/);
    expect(text).toMatch(/duplicate e1/);
    expect(text).toMatch(/the outline has 4 H2s and H3s, the target says 7/);
  });

  it("knows the forms a part can take", () => {
    const raw = load();
    raw.outline[1].form = "infographic";
    expect(Brief.safeParse(raw).success).toBe(false);
  });
});
