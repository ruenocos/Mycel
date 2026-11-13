import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientContext, SitePages } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import { RunStore } from "../log/run-store.ts";
import { runStep, StepValidationError } from "../step.ts";
import { editField, markConfirmed, reviewAnswer, showField, unreviewed } from "./confirm.ts";
import type { JsonModel } from "./llm.ts";
import {
  buildContextMessages,
  buildEvidence,
  CLIENT_QUESTIONS,
  type ContextProposal,
  checkProposal,
  contextProposeStep,
  questionText,
} from "./propose.ts";

const root = join(import.meta.dirname, "../../../../fixtures/clients");
const site = (name: string) =>
  SitePages.parse(JSON.parse(readFileSync(join(root, name, "pages.json"), "utf8")));
const market = { country: "NL", language: "nl" };

const proposal = (over: Partial<ContextProposal> = {}): ContextProposal => ({
  siteName: "Plantpost",
  sourceContext: "Webshop die kamerplanten per post verstuurt.",
  centralEntities: [
    { name: "kamerplant", disambiguation: "plant in een pot, binnen", notThis: ["tuinplant"] },
  ],
  centralSearchIntent: "kamerplanten kiezen, kopen en verzorgen",
  audiences: ["stedelingen"],
  offerings: ["kamerplanten", "plantenpotten"],
  competitors: [],
  answers: CLIENT_QUESTIONS.map((q) => ({
    id: q.id,
    answer: `antwoord ${q.id}`,
    evidence: ["page:/"],
  })),
  ...over,
});

/** A stub model that returns the queued proposals in order and records each request. */
function stub(...queue: ContextProposal[]): JsonModel & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    async generateJson(req, schema) {
      requests.push(req);
      const next = queue.shift();
      if (!next) throw new Error("stub ran out of proposals");
      return schema.parse(next);
    },
  };
}

const newRun = () =>
  RunStore.create({
    runsDir: mkdtempSync(join(tmpdir(), "mycel-ctx-")),
    client: "test",
    command: "test",
    cliVersion: "0.0.0",
  });

describe("buildEvidence", () => {
  for (const name of ["plantpost", "praktijk-beweegruimte"]) {
    it(`lists every page and gives body text to business pages only (${name})`, () => {
      const s = site(name);
      const ev = buildEvidence(s, "https://example.test");
      expect(ev.pages).toHaveLength(s.pages.length);
      const withText = ev.pages.filter((p) => p.text);
      expect(withText.length).toBeGreaterThan(0);
      expect(withText.length).toBeLessThanOrEqual(12);
      expect(withText.every((p) => p.kind !== "blog" && p.kind !== "guide")).toBe(true);
      expect(ev.pages.find((p) => p.kind === "home")?.text).toBeTruthy();
      // Deterministic: same input, same evidence.
      expect(buildEvidence(s, "https://example.test")).toEqual(ev);
    });
  }
});

describe("buildContextMessages", () => {
  it("instructs in English, asks for the market language and passes the evidence untranslated", () => {
    const ev = buildEvidence(site("plantpost"), "https://plantpost.example");
    const [system, user] = buildContextMessages(ev, market);
    expect(system?.content).toContain("Write every value in Dutch (nl)");
    expect(system?.content).toContain("Never invent facts");
    expect(system?.content).toContain(
      "Never put competitors, alternatives or related products in notThis",
    );
    for (const q of CLIENT_QUESTIONS) expect(user?.content).toContain(`- ${q.id}: ${q.en}`);
    const home = ev.pages.find((p) => p.kind === "home");
    expect(user?.content).toContain(`${home?.id} | home | ${home?.title}`);
    expect(user?.content).toContain("COMPETING DOMAINS: no data");
  });
});

describe("checkProposal", () => {
  it("drops unknown evidence ids and competitors that weren't in the data, and reports missing answers", () => {
    const ev = buildEvidence(site("plantpost"), "https://plantpost.example");
    const p = proposal({
      competitors: ["made-up.nl"],
      answers: [
        { id: "offerings", answer: "planten", evidence: ["page:/", "page:/bestaat-niet/"] },
      ],
    });
    const r = checkProposal(p, ev);
    expect(r.proposal.competitors).toEqual([]);
    expect(r.proposal.answers[0]?.evidence).toEqual(["page:/"]);
    expect(r.removed).toHaveLength(2);
    expect(r.missing).toHaveLength(CLIENT_QUESTIONS.length - 1);
  });
});

describe("contextProposeStep", () => {
  it("turns a proposal into a proposed ClientContext with questions in the market language", async () => {
    const ev = buildEvidence(site("plantpost"), "https://plantpost.example");
    const llm = stub(proposal());
    const out = await runStep(newRun(), contextProposeStep(llm), {
      evidence: ev,
      market,
      model: "m",
    });
    expect(out.confirmed).toBeUndefined();
    expect(out.answers).toHaveLength(9);
    expect(out.answers.every((a) => a.status === "proposed")).toBe(true);
    expect(out.answers[0]?.question).toBe(questionText("offerings", "nl"));
    expect(llm.requests).toHaveLength(1);
  });

  it("asks again with a new seed when answers are missing", async () => {
    const ev = buildEvidence(site("plantpost"), "https://plantpost.example");
    const llm = stub(proposal({ answers: [] }), proposal());
    const out = await runStep(newRun(), contextProposeStep(llm), {
      evidence: ev,
      market,
      model: "m",
    });
    expect(out.answers).toHaveLength(9);
    const seeds = llm.requests.map((r) => (r as { params: { seed: number } }).params.seed);
    expect(new Set(seeds).size).toBe(2);
  });

  it("stops the run when answers stay missing", async () => {
    const ev = buildEvidence(site("plantpost"), "https://plantpost.example");
    const empty = proposal({ answers: [] });
    const llm = stub(empty, empty, empty, empty);
    await expect(
      runStep(newRun(), contextProposeStep(llm), { evidence: ev, market, model: "m" }),
    ).rejects.toBeInstanceOf(StepValidationError);
  });
});

describe("confirm", () => {
  const ctx = (): ClientContext =>
    ClientContext.parse(
      JSON.parse(readFileSync(join(root, "praktijk-beweegruimte", "context.json"), "utf8")),
    );

  it("edits fields in the terminal formats", () => {
    let c = editField(ctx(), "market", "nl / NL / Amersfoort");
    expect(c.market).toEqual({ country: "NL", language: "nl", city: "Amersfoort" });
    c = editField(c, "offerings", "fysiotherapie; dry needling ;  ");
    expect(c.offerings).toEqual(["fysiotherapie", "dry needling"]);
    c = editField(
      c,
      "centralEntities",
      "fysiotherapie = behandeling van klachten aan het bewegingsapparaat (not: fysica, fitness)",
    );
    expect(c.centralEntities[0]).toEqual({
      name: "fysiotherapie",
      disambiguation: "behandeling van klachten aan het bewegingsapparaat",
      notThis: ["fysica", "fitness"],
    });
    expect(showField(c, "market")).toBe("NL / nl / Amersfoort");
    expect(() => editField(c, "market", "Nederland")).toThrow();
  });

  it("confirms only when every answer was reviewed", () => {
    let c = ctx();
    expect(() => markConfirmed(c, "Wons", new Date())).toThrow(/unreviewed/);
    const [first, ...rest] = c.answers;
    c = reviewAnswer(c, first?.id ?? "", "Een nieuw antwoord.");
    expect(c.answers[0]?.status).toBe("edited");
    for (const a of rest) c = reviewAnswer(c, a.id);
    expect(unreviewed(c)).toEqual([]);
    expect(c.answers.slice(1).every((a) => a.status === "confirmed")).toBe(true);
    const done = markConfirmed(c, "Wons", new Date("2026-11-13T22:00:00Z"));
    expect(done.confirmed).toEqual({ by: "Wons", at: "2026-11-13T22:00:00.000Z" });
  });
});
