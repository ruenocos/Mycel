import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientContext } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import { contextConfirm, contextPropose, parseMarket } from "./context.ts";

const fixture = (name: string) => join(import.meta.dirname, "../../../fixtures/clients", name);
const tmp = () => mkdtempSync(join(tmpdir(), "mycel-cli-ctx-"));

describe("parseMarket", () => {
  it("reads country / language / city", () => {
    expect(parseMarket("nl / NL / Utrecht")).toEqual({
      country: "NL",
      language: "nl",
      city: "Utrecht",
    });
    expect(() => parseMarket("Nederland")).toThrow();
  });
});

describe("mycel context propose", () => {
  it("proposes a context for a fixture with the fake model and logs both steps", async () => {
    const dir = tmp();
    const outFile = join(dir, "context.json");
    const res = await contextPropose({
      runsDir: join(dir, "runs"),
      site: fixture("praktijk-beweegruimte"),
      market: "NL / nl / Utrecht",
      out: outFile,
      provider: "fake",
      model: "fake-model",
      env: {},
    });
    expect(res.ok).toBe(true);
    const ctx = ClientContext.parse(JSON.parse(readFileSync(outFile, "utf8")));
    expect(ctx.market).toEqual({ country: "NL", language: "nl", city: "Utrecht" });
    expect(ctx.answers).toHaveLength(9);
    expect(ctx.answers[0]?.question).toBe("Wat verkoop of bied je aan?");
    expect(res.timeline).toContain("context-sources");
    expect(res.timeline).toContain("context-propose");
    expect(res.lines.join("\n")).toContain("0 GSC queries, 0 ranked keywords, 0 competitors");
  });

  it("asks for a market when a fixture has none", async () => {
    const dir = tmp();
    const res = await contextPropose({
      runsDir: join(dir, "runs"),
      site: fixture("plantpost"),
      out: join(dir, "c.json"),
      provider: "fake",
      model: "m",
      env: {},
    });
    expect(res.ok).toBe(false);
    expect(res.lines.join("\n")).toContain("--market");
  });
});

describe("mycel context confirm", () => {
  it("keeps on Enter, edits typed text, re-asks after a bad edit and stamps the confirmation", async () => {
    const dir = tmp();
    const file = join(dir, "context.json");
    writeFileSync(file, readFileSync(join(fixture("praktijk-beweegruimte"), "context.json")));
    const before = ClientContext.parse(JSON.parse(readFileSync(file, "utf8")));
    const answers = [
      "Nederland", // market: invalid, asked again
      "NL / nl / Utrecht",
      "", // source context
      "",
      "",
      "", // audiences
      "fysiotherapie; manuele therapie", // offerings
      "", // competitors
      ...before.answers.map((_, i) => (i === 0 ? "Fysio en manuele therapie." : "")),
    ];
    const printed: string[] = [];
    const ctx = await contextConfirm(
      file,
      "Wons",
      { print: (l) => printed.push(l), ask: async () => answers.shift() ?? "" },
      () => new Date("2026-11-13T22:00:00Z"),
    );
    expect(answers).toHaveLength(0);
    expect(printed.join("\n")).toContain("That didn't fit");
    expect(ctx.offerings).toEqual(["fysiotherapie", "manuele therapie"]);
    expect(ctx.answers[0]).toMatchObject({
      answer: "Fysio en manuele therapie.",
      status: "edited",
    });
    expect(ctx.answers.slice(1).every((a) => a.status === "confirmed")).toBe(true);
    expect(ctx.confirmed).toEqual({ by: "Wons", at: "2026-11-13T22:00:00.000Z" });
    expect(ClientContext.parse(JSON.parse(readFileSync(file, "utf8")))).toEqual(ctx);
  });
});
