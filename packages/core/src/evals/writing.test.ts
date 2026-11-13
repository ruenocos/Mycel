import type { WritingOutput, WritingTestSet } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import { autoCheck, blindSheet, buildWritingMessages, parseScores, verdict } from "./writing.ts";

// Synthetic set (Plantpost is fictional), so it may live in the repo.
const set: WritingTestSet = {
  name: "Schrijftest",
  version: "1",
  language: "nl",
  brand: "Vriendelijk en praktisch, je-vorm.",
  tasks: [
    {
      id: "t1",
      kind: "title",
      instruction: "Schrijf een SEO-titel over gele bladeren.",
      sources: [
        { id: "s1", url: "https://plantpost.example/gele-bladeren/", text: "Te veel water." },
      ],
      limits: { maxChars: 60 },
    },
    {
      id: "f1",
      kind: "factual",
      instruction: "Waarom krijgt een plant gele bladeren?",
      sources: [
        { id: "s1", url: "https://plantpost.example/gele-bladeren/", text: "Te veel water." },
      ],
      limits: {},
    },
  ],
};
const models = [{ model: "m-a", digest: "aaa" }, { model: "m-b" }, { model: "m-c" }];
const outputs: WritingOutput[] = set.tasks.flatMap((t) =>
  models.map((m) => ({ taskId: t.id, model: m.model, text: `${m.model} schrijft over ${t.id}.` })),
);

describe("buildWritingMessages", () => {
  it("puts brand and the no-invention rule in the system prompt and the sources in the user prompt", () => {
    const [system, user] = buildWritingMessages(set, set.tasks[0] ?? ({} as never));
    expect(system?.content).toContain("Vriendelijk en praktisch");
    expect(system?.content).toContain("verzin het dan niet");
    expect(user?.content).toContain("maximaal 60 tekens");
    expect(user?.content).toContain(
      "[s1] https://plantpost.example/gele-bladeren/\nTe veel water.",
    );
  });
});

describe("autoCheck", () => {
  it("flags length, AI phrases and missing citations", () => {
    const [title, factual] = set.tasks;
    const long = autoCheck(title ?? ({} as never), `${"x".repeat(70)}`);
    expect(long.issues).toEqual(["too long: 70/60 chars"]);
    const ai = autoCheck(title ?? ({} as never), "Ontdek in de huidige markt naadloos alles.");
    expect(ai.aiPatterns).toEqual(["in de huidige", "naadloos", "ontdek"]);
    expect(autoCheck(factual ?? ({} as never), "Te veel water.").issues).toEqual([
      "no source cited",
    ]);
    expect(autoCheck(factual ?? ({} as never), "Te veel water [s9].").issues).toEqual([
      "unknown source ids: s9",
    ]);
    expect(autoCheck(factual ?? ({} as never), "Te veel water [s1].").issues).toEqual([]);
  });
});

describe("blindSheet + verdict", () => {
  const sheet = blindSheet(set, outputs, "run-1", models);

  it("hides the model names and is the same for the same run", () => {
    expect(sheet.markdown).not.toContain("m-a@");
    expect(sheet.markdown).toContain("### A");
    expect(blindSheet(set, outputs, "run-1", models).key).toEqual(sheet.key);
    expect(Object.values(sheet.key.tasks.t1 ?? {}).sort()).toEqual(["m-a", "m-b", "m-c"]);
    expect(sheet.csv.split("\n")[0]).toBe("taskId,label,natural,correct,tone,invented");
  });

  const fill = (score: (model: string) => [number, number, number, string]) =>
    `${sheet.csv
      .trim()
      .split("\n")
      .map((line, i) => {
        if (i === 0) return line;
        const [task, label] = line.split(",");
        const model = sheet.key.tasks[task ?? ""]?.[label ?? ""] ?? "";
        return [task, label, ...score(model)].join(",");
      })
      .join("\n")}\n`;

  it("lets the candidate write when it is close and clean", () => {
    const csv = fill((m) =>
      m === "m-b" ? [5, 5, 5, ""] : m === "m-a" ? [5, 4, 5, ""] : [3, 3, 3, ""],
    );
    const v = verdict(set, sheet.key, parseScores(csv), "m-a");
    expect(v.best).toBe("m-b");
    expect(v.candidateWrites).toBe(true);
    expect(v.results.find((r) => r.model === "m-a")?.digest).toBe("aaa");
  });

  it("says model per task when the candidate invents a fact", () => {
    const csv = fill((m) => (m === "m-a" ? [5, 5, 5, "y"] : [4, 4, 4, ""]));
    const v = verdict(set, sheet.key, parseScores(csv), "m-a");
    expect(v.candidateWrites).toBe(false);
    expect(v.reason).toContain("invented facts in 2 answer(s)");
  });

  it("rejects an unfilled sheet with a clear message", () => {
    expect(() => parseScores(sheet.csv)).toThrow(/line 2: natural must be 1-5/);
  });
});
