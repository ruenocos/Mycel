import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CLUSTER_VERSION } from "../cluster/cluster.ts";
import { RunStore } from "../log/run-store.ts";
import { defineStep, runStep } from "../step.ts";
import { hostFromFolder, type PipelineStepId, pipelineStatus } from "./status.ts";

const fixture = join(import.meta.dirname, "../../../../fixtures/clients/plantpost");
const HOUR = 3_600_000;

/** A client folder whose files were written one after the other, an hour apart, ending now. */
function folder(files: string[], context: "confirmed" | "proposed" = "confirmed") {
  const root = mkdtempSync(join(tmpdir(), "mycel-status-"));
  const dir = join(root, "plantpost.example");
  mkdirSync(dir);
  const ctx = JSON.parse(readFileSync(join(fixture, "context.json"), "utf8"));
  if (context === "confirmed") ctx.confirmed = { by: "Wons", at: "2026-11-14T08:00:00.000Z" };
  const start = Date.now() - files.length * HOUR;
  for (const [i, file] of files.entries()) {
    // Only the context is read; the datasets are judged on their date.
    writeFileSync(join(dir, file), file === "context.json" ? JSON.stringify(ctx) : "{}");
    touch(join(dir, file), start + i * HOUR);
  }
  return { dir, runsDir: join(root, "runs") };
}
const touch = (path: string, ms: number) => utimesSync(path, new Date(ms), new Date(ms));

const DATASETS = ["context.json", "research.json", "queries.json", "clusters.json"];

const states = (dir: string, runsDir: string) =>
  Object.fromEntries(pipelineStatus(dir, { runsDir }).steps.map((s) => [s.step, s.state]));
const actions = (dir: string, runsDir: string) =>
  pipelineStatus(dir, { runsDir }).next.map((a) => `${a.step}:${a.action}`);

describe("pipelineStatus", () => {
  it("starts with the context: propose it, then a person confirms it", () => {
    const empty = folder([]);
    expect(actions(empty.dir, empty.runsDir)).toEqual(["context:propose"]);
    expect(pipelineStatus(empty.dir, empty).client).toBeNull();

    const proposed = folder(["context.json"], "proposed");
    const status = pipelineStatus(proposed.dir, proposed);
    expect(status).toMatchObject({ client: "plantpost.example", done: false });
    expect(status.steps[0]).toMatchObject({ step: "context", state: "waiting" });
    // Nothing else can start on a context nobody confirmed.
    expect(status.next).toMatchObject([{ step: "context", action: "confirm" }]);

    const confirmed = folder(["context.json"]);
    expect(pipelineStatus(confirmed.dir, confirmed).steps[0]).toMatchObject({
      state: "ok",
      detail: "confirmed by Wons on 2026-11-14",
    });
    expect(actions(confirmed.dir, confirmed.runsDir)).toEqual(["research:run"]);
  });

  it("lets filter and cluster go on while the business profile waits for its owner", () => {
    const { dir, runsDir } = folder(["context.json", "research.json"]);
    expect(actions(dir, runsDir)).toEqual(["business:propose", "filter:run"]);

    writeFileSync(join(dir, "business.proposed.json"), "{}");
    expect(states(dir, runsDir).business).toBe("waiting");
    expect(actions(dir, runsDir)).toEqual(["business:answers", "filter:run"]);

    writeFileSync(join(dir, "owner-answers.json"), "{}");
    expect(actions(dir, runsDir)).toEqual(["business:apply", "filter:run"]);

    // The data steps are done; the map still waits for the profile it is built on.
    for (const file of ["queries.json", "clusters.json"]) writeFileSync(join(dir, file), "{}");
    expect(actions(dir, runsDir)).toEqual(["business:apply"]);
  });

  it("flags a file that is older than the file it was made from", () => {
    const { dir, runsDir } = folder([...DATASETS, "topical-map.json"]);
    expect(states(dir, runsDir)).toMatchObject({ filter: "ok", cluster: "ok", map: "ok" });

    // The filter ran again: the clusters were made from the queries before that.
    touch(join(dir, "queries.json"), Date.now());
    const status = pipelineStatus(dir, { runsDir });
    const cluster = status.steps.find((s) => s.step === "cluster");
    expect(cluster).toMatchObject({
      state: "stale",
      detail: "older than queries.json, which it is made from",
    });
    // Clustering comes first; the map is made again after it.
    expect(status.next.map((a) => a.step)).toEqual(["business", "cluster"]);
    expect(status.done).toBe(false);
  });

  it("flags a file an older version of its step made, from the run that wrote it", async () => {
    const stepOf = (version: string) =>
      defineStep({
        name: "cluster",
        version,
        input: z.object({}),
        output: z.object({}),
        run: async () => ({}),
      });
    const madeBy = async (version: string) => {
      const { dir, runsDir } = folder(DATASETS.slice(0, 3));
      const run = RunStore.create({
        runsDir,
        client: "www.plantpost.example",
        command: "cluster",
        cliVersion: "0",
      });
      await runStep(run, stepOf(version), {});
      writeFileSync(join(dir, "clusters.json"), "{}");
      run.finish();
      const cluster = pipelineStatus(dir, { runsDir }).steps.find((s) => s.step === "cluster");
      return { cluster, runId: run.runId };
    };

    const old = await madeBy("1");
    expect(old.cluster).toMatchObject({
      state: "stale",
      detail: `made by cluster version 1; the step is at version ${CLUSTER_VERSION} now`,
      madeBy: { runId: old.runId, stepVersion: "1" },
    });

    const current = await madeBy(CLUSTER_VERSION);
    expect(current.cluster).toMatchObject({
      state: "ok",
      madeBy: { runId: current.runId, stepVersion: CLUSTER_VERSION },
    });
    expect(current.cluster?.detail).toContain(`made by run ${current.runId}`);
  });

  it("says so when it can't tell: no run record is not a reason to call a file stale", () => {
    const { dir, runsDir } = folder(DATASETS);
    const cluster = pipelineStatus(dir, { runsDir }).steps.find((s) => s.step === "cluster");
    expect(cluster?.state).toBe("ok");
    expect(cluster?.detail).toContain("no run record of it here");
    expect(cluster?.madeBy).toBeUndefined();
  });

  it("reports a context that can't be read instead of crashing on it", () => {
    const { dir, runsDir } = folder(["context.json", "research.json"]);
    writeFileSync(join(dir, "context.json"), "{ not json");
    const status = pipelineStatus(dir, { runsDir });
    expect(status.steps[0]?.state).toBe("invalid");
    expect(status.steps[0]?.detail).toContain("not valid JSON");
    expect(status.next).toMatchObject([{ step: "context", action: "propose" }]);

    writeFileSync(join(dir, "context.json"), JSON.stringify({ site: {} }));
    expect(pipelineStatus(dir, { runsDir }).steps[0]?.detail).toMatch(/^not a context file: /);
  });

  it("is done when every file is there, confirmed and up to date", () => {
    const { dir, runsDir } = folder(DATASETS);
    const key = JSON.parse(readFileSync(join(fixture, "business.key.json"), "utf8"));
    const profile = { ...key, confirmed: { by: "owner", at: "2026-11-15T10:00:00.000Z" } };
    writeFileSync(join(dir, "business.json"), JSON.stringify(profile));
    writeFileSync(join(dir, "topical-map.json"), "{}");
    const status = pipelineStatus(dir, { runsDir });
    const order: PipelineStepId[] = ["context", "research", "business", "filter", "cluster", "map"];
    expect(status.steps.map((s) => s.step)).toEqual(order);
    expect(status.steps.map((s) => s.state)).toEqual(order.map(() => "ok"));
    expect(status).toMatchObject({ done: true, next: [] });
  });

  it("reads a site from a folder name only when the name is one", () => {
    expect(hostFromFolder("clients/plantpost.example")).toBe("plantpost.example");
    expect(hostFromFolder("C:\\plan\\clients\\De-Saak.com".replaceAll("\\", "/"))).toBe(
      "de-saak.com",
    );
    expect(hostFromFolder("fixtures/clients/plantpost")).toBeNull();
  });
});
