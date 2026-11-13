import type { WritingOutput, WritingTestSet } from "@mycel/schema";
import { describe, expect, it } from "vitest";
import {
  autoCheck,
  blindSheet,
  buildWritingMessages,
  parseScores,
  parseWriter,
  verdict,
} from "./writing.ts";

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

  it("reads semicolon CSV too (Excel with Dutch settings)", () => {
    const [row] = parseScores("taskId;label;natural;correct;tone;invented\nt1;A;4;5;3;j\n");
    expect(row).toEqual({
      taskId: "t1",
      label: "A",
      natural: 4,
      correct: 5,
      tone: 3,
      inventedFact: true,
    });
  });

  it("rejects an unfilled sheet with a clear message", () => {
    expect(() => parseScores(sheet.csv)).toThrow(/line 2: natural must be 1-5/);
  });
});

describe("English instructions (ADR 0013)", () => {
  it("parses writers with and without +en", () => {
    expect(parseWriter("gemma4:31b")).toEqual({
      label: "gemma4:31b",
      model: "gemma4:31b",
      instructions: "market",
    });
    expect(parseWriter("deepseek-v4.1-flash+en")).toEqual({
      label: "deepseek-v4.1-flash+en",
      model: "deepseek-v4.1-flash",
      instructions: "en",
    });
    expect(() => parseWriter("m+fr")).toThrow(/only \+en/);
    expect(() => parseWriter("+en")).toThrow(/empty model/);
  });

  it("writes English instructions but asks for the answer in the market language", () => {
    const task = {
      ...(set.tasks[0] ?? ({} as never)),
      instructionEn: 'Write an SEO title. Keyword: "gele bladeren".',
    };
    const [system, user] = buildWritingMessages(set, task, "en");
    expect(system?.content).toContain("experienced Dutch web editor");
    expect(system?.content).toContain("House style (in Dutch): Vriendelijk en praktisch");
    expect(user?.content).toContain('Keyword: "gele bladeren"');
    expect(user?.content).toContain("Length: at most 60 characters.");
    expect(user?.content).toContain("Write the answer in Dutch (nl).");
    // Sources are passed untranslated.
    expect(user?.content).toContain(
      "[s1] https://plantpost.example/gele-bladeren/\nTe veel water.",
    );
  });

  it("falls back to the market-language instruction, labelled, when no English one exists", () => {
    const [, user] = buildWritingMessages(set, set.tasks[1] ?? ({} as never), "en");
    expect(user?.content).toContain(
      "Task (written in Dutch): Waarom krijgt een plant gele bladeren?",
    );
  });

  it("uses the English house style when the set has one", () => {
    const [system] = buildWritingMessages(
      { ...set, brandEn: "Friendly and practical." },
      set.tasks[0] ?? ({} as never),
      "en",
    );
    expect(system?.content).toContain("House style: Friendly and practical.");
  });
});
