import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Brief, BusinessProfile, ClientContext } from "@mycel/schema";
import { BRIEF_STEP_VERSION, BRIEFS_DIR } from "../brief/step.ts";
import { CLUSTER_VERSION } from "../cluster/cluster.ts";
import { FILTER_STEP_VERSION } from "../filter/classify.ts";
import { listRuns } from "../log/timeline.ts";
import type { RunMeta } from "../log/types.ts";
import { MAP_STEP_VERSION } from "../map/step.ts";
import { RESEARCH_VERSION } from "../research/collect.ts";
import { SIGNALS_VERSION } from "../signals/step.ts";
import { savedStepVersion } from "../step.ts";

/**
 * Where a client stands in the pipeline (issue #45): which files are in its folder, whether a
 * person confirmed what needs confirming, whether a file is out of date, and what to do next.
 *
 * It reads the folder and the run records and nothing else: no run, no call, no file written.
 * Only context.json and business.json are opened (they are small and carry the confirmation);
 * the datasets are judged on their date and on the run that wrote them.
 */

export const PIPELINE_STEPS = [
  "context",
  "research",
  "business",
  "filter",
  "cluster",
  "signals",
  "map",
  "brief",
] as const;
export type PipelineStepId = (typeof PIPELINE_STEPS)[number];

/**
 * - missing: the file isn't there
 * - waiting: it is there, and a person still has to confirm it
 * - stale: it is older than a file it was made from, or an older version of the step made it
 * - invalid: it can't be read as what it should be
 */
export type PipelineState = "ok" | "missing" | "waiting" | "stale" | "invalid";

interface StepSpec {
  id: PipelineStepId;
  file: string;
  /** These have to be ok before this step can be done. */
  needs: PipelineStepId[];
  /** A newer file of one of these makes this one out of date. */
  madeFrom: PipelineStepId[];
  /** Set for the steps Mycel runs on its own: the run command and step that write the file. */
  run?: { command: string; step: string; version: string };
}

/**
 * The route, in order. The business profile comes right after research (it reads the searches
 * as evidence) and before the map (which is built on it); filter and cluster don't wait for it,
 * because the owner's answers can take a while.
 */
const SPECS: StepSpec[] = [
  { id: "context", file: "context.json", needs: [], madeFrom: [] },
  {
    id: "research",
    file: "research.json",
    needs: ["context"],
    madeFrom: ["context"],
    run: { command: "research", step: "research-collect", version: RESEARCH_VERSION },
  },
  // Confirmed by the owner: never called stale on a date, a person decides when to redo it.
  { id: "business", file: "business.json", needs: ["context", "research"], madeFrom: [] },
  {
    id: "filter",
    file: "queries.json",
    needs: ["research"],
    madeFrom: ["research", "context"],
    run: { command: "filter", step: "filter", version: FILTER_STEP_VERSION },
  },
  {
    id: "cluster",
    file: "clusters.json",
    needs: ["filter"],
    madeFrom: ["filter", "context"],
    run: { command: "cluster", step: "cluster", version: CLUSTER_VERSION },
  },
  // Trends and competitors (issue #63): what the map reads besides the clusters.
  {
    id: "signals",
    file: "signals.json",
    needs: ["cluster"],
    madeFrom: ["cluster", "context"],
    run: { command: "signals", step: "signals", version: SIGNALS_VERSION },
  },
  {
    id: "map",
    file: "topical-map.json",
    needs: ["cluster", "business", "signals"],
    madeFrom: ["cluster", "context", "business", "signals"],
    run: { command: "map", step: "map", version: MAP_STEP_VERSION },
  },
  // One brief per page (ADR 0020), in a folder: ok once there is one and none is out of date.
  { id: "brief", file: BRIEFS_DIR, needs: ["map"], madeFrom: ["map", "business"] },
];

export const BUSINESS_PROPOSAL_FILE = "business.proposed.json";
export const OWNER_ANSWERS_FILE = "owner-answers.json";

export interface PipelineStepStatus {
  step: PipelineStepId;
  /** Path of the file this step writes, inside the client folder. */
  file: string;
  state: PipelineState;
  /** One sentence: why it isn't ok, or what makes it ok. */
  detail: string;
  modifiedAt?: string;
  /** The run that wrote the file, when the run records still have it. */
  madeBy?: { runId: string; stepVersion?: string };
}

/**
 * What can be done now.
 * - propose / run: a command Mycel runs (context propose, business propose, research, ...)
 * - confirm: a person goes through the proposed context
 * - answers: the owner's answers to the business proposal are not there yet
 * - apply: the owner's answers are there, apply them
 */
export interface PipelineAction {
  step: PipelineStepId;
  action: "propose" | "confirm" | "answers" | "apply" | "run";
  reason: string;
}

export interface PipelineStatus {
  dir: string;
  /** The site's host, from the context. Null while there is no readable context. */
  client: string | null;
  /** The site URL from the context. */
  site?: string;
  steps: PipelineStepStatus[];
  /** Everything that can be done now, in pipeline order. Empty when all is up to date. */
  next: PipelineAction[];
  done: boolean;
}

export interface PipelineStatusOptions {
  runsDir: string;
}

const bare = (host: string) => host.replace(/^www\./, "");
const day = (iso: string) => iso.slice(0, 10);

/** A small JSON file read against its schema; the reason comes back when it can't be. */
function readSmall<T>(
  path: string,
  parse: (raw: unknown) => { success: true; data: T } | { success: false; why: string },
): { ok: true; data: T } | { ok: false; why: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // Not swallowed: the reason is the status of this file.
    return { ok: false, why: `not valid JSON (${(err as Error).message})` };
  }
  const parsed = parse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, why: parsed.why };
}

const firstIssue = (issues: { path: PropertyKey[]; message: string }[]) => {
  const i = issues[0];
  const more = issues.length > 1 ? `, and ${issues.length - 1} more` : "";
  return i ? `${i.path.join(".") || "the file"}: ${i.message}${more}` : "unknown problem";
};

/** The latest finished run of this command for this client that wrote a file at that time. */
function writerOf(runs: RunMeta[], command: string, client: string, mtimeMs: number) {
  // A step writes its file just before its run ends; two seconds cover coarse file clocks.
  const SLACK_MS = 2000;
  return runs.find(
    (r) =>
      r.command === command &&
      bare(r.client) === client &&
      r.status === "ok" &&
      r.endedAt !== undefined &&
      mtimeMs >= new Date(r.startedAt).getTime() - SLACK_MS &&
      mtimeMs <= new Date(r.endedAt).getTime() + SLACK_MS,
  );
}

export function pipelineStatus(dir: string, opts: PipelineStatusOptions): PipelineStatus {
  const path = (file: string) => join(dir, file);
  const mtime = new Map<PipelineStepId, number>();
  for (const s of SPECS) {
    if (existsSync(path(s.file))) mtime.set(s.id, statSync(path(s.file)).mtimeMs);
  }
  const steps = new Map<PipelineStepId, PipelineStepStatus>();
  const set = (
    spec: StepSpec,
    state: PipelineState,
    detail: string,
    madeBy?: PipelineStepStatus["madeBy"],
  ) => {
    const at = mtime.get(spec.id);
    steps.set(spec.id, {
      step: spec.id,
      file: path(spec.file),
      state,
      detail,
      ...(at !== undefined ? { modifiedAt: new Date(at).toISOString() } : {}),
      ...(madeBy ? { madeBy } : {}),
    });
  };

  // The context: is it there, can it be read, did a person confirm it.
  let context: ClientContext | undefined;
  const [contextSpec, ...rest] = SPECS as [StepSpec, ...StepSpec[]];
  if (!mtime.has("context")) {
    set(contextSpec, "missing", "no context.json yet");
  } else {
    const read = readSmall(path(contextSpec.file), (raw) => {
      const p = ClientContext.safeParse(raw);
      return p.success ? p : { success: false, why: firstIssue(p.error.issues) };
    });
    if (!read.ok) set(contextSpec, "invalid", `not a context file: ${read.why}`);
    else {
      context = read.data;
      if (context.confirmed) {
        const c = context.confirmed;
        set(contextSpec, "ok", `confirmed by ${c.by} on ${day(c.at)}`);
      } else set(contextSpec, "waiting", "proposed, not confirmed by a person yet");
    }
  }
  const client = context ? bare(new URL(context.site.url).hostname) : null;
  const runs = client && existsSync(opts.runsDir) ? listRuns(opts.runsDir) : [];

  for (const spec of rest) {
    const at = mtime.get(spec.id);
    if (spec.id === "business") {
      businessStatus(spec, dir, at, set);
      continue;
    }
    if (spec.id === "brief") {
      briefStatus(spec, dir, mtime, set);
      continue;
    }
    if (at === undefined) {
      set(spec, "missing", `no ${spec.file} yet`);
      continue;
    }
    const newer = spec.madeFrom
      .map((id) => ({ id, at: mtime.get(id) }))
      .find((input) => input.at !== undefined && input.at > at);
    const writer = spec.run && client ? writerOf(runs, spec.run.command, client, at) : undefined;
    const version =
      writer && spec.run
        ? savedStepVersion(join(opts.runsDir, writer.runId), spec.run.step)
        : undefined;
    const madeBy = writer
      ? { runId: writer.runId, ...(version !== undefined ? { stepVersion: version } : {}) }
      : undefined;
    if (newer) {
      const input = SPECS.find((s) => s.id === newer.id)?.file ?? newer.id;
      set(spec, "stale", `older than ${input}, which it is made from`, madeBy);
    } else if (spec.run && version !== undefined && version !== spec.run.version) {
      set(
        spec,
        "stale",
        `made by ${spec.run.step} version ${version}; the step is at version ${spec.run.version} now`,
        madeBy,
      );
    } else {
      const made = writer ? `made by run ${writer.runId}` : "no run record of it here";
      set(spec, "ok", `${day(new Date(at).toISOString())}, ${made}`, madeBy);
    }
  }

  const ordered = SPECS.map((s) => steps.get(s.id) as PipelineStepStatus);
  const ok = (id: PipelineStepId) => steps.get(id)?.state === "ok";
  const next: PipelineAction[] = [];
  for (const spec of SPECS) {
    const s = steps.get(spec.id) as PipelineStepStatus;
    if (s.state === "ok" || !spec.needs.every(ok)) continue;
    next.push({ step: spec.id, action: actionFor(spec, s, dir), reason: s.detail });
  }
  return {
    dir,
    client,
    ...(context ? { site: context.site.url } : {}),
    steps: ordered,
    next,
    done: ordered.every((s) => s.state === "ok"),
  };
}

function businessStatus(
  spec: StepSpec,
  dir: string,
  at: number | undefined,
  set: (spec: StepSpec, state: PipelineState, detail: string) => void,
): void {
  if (at === undefined) {
    if (!existsSync(join(dir, BUSINESS_PROPOSAL_FILE))) {
      set(spec, "missing", "no business profile yet");
    } else if (existsSync(join(dir, OWNER_ANSWERS_FILE))) {
      set(spec, "waiting", `proposed, and the owner's answers are in ${OWNER_ANSWERS_FILE}`);
    } else {
      set(spec, "waiting", "proposed, waiting for the owner's answers");
    }
    return;
  }
  const read = readSmall(join(dir, spec.file), (raw) => {
    const { $comment: _c, ...profile } = (raw ?? {}) as Record<string, unknown>;
    const p = BusinessProfile.safeParse(profile);
    return p.success ? p : { success: false, why: firstIssue(p.error.issues) };
  });
  if (!read.ok) set(spec, "invalid", `not a business profile: ${read.why}`);
  else if (read.data.confirmed) {
    const c = read.data.confirmed;
    set(spec, "ok", `confirmed by ${c.by} on ${day(c.at)}`);
  } else set(spec, "waiting", "not confirmed by the owner yet");
}

/**
 * The briefs folder: missing until it holds a brief; invalid when one can't be read; stale when a
 * brief is older than the map or the business profile it was made from, or an older version of
 * the step wrote it. Briefs are small, so each one is read.
 */
function briefStatus(
  spec: StepSpec,
  dir: string,
  mtime: Map<PipelineStepId, number>,
  set: (spec: StepSpec, state: PipelineState, detail: string) => void,
): void {
  const folder = join(dir, spec.file);
  const files = existsSync(folder)
    ? readdirSync(folder)
        .filter((f) => f.endsWith(".json"))
        .sort()
    : [];
  if (!files.length) {
    set(spec, "missing", "no briefs yet");
    return;
  }
  const newest = Math.max(
    ...spec.madeFrom.map((id) => mtime.get(id)).filter((t) => t !== undefined),
  );
  let older = 0;
  let oldVersion: string | undefined;
  for (const file of files) {
    const path = join(folder, file);
    const read = readSmall(path, (raw) => {
      const p = Brief.safeParse(raw);
      return p.success ? p : { success: false, why: firstIssue(p.error.issues) };
    });
    if (!read.ok) {
      set(spec, "invalid", `${spec.file}/${file} is not a brief: ${read.why}`);
      return;
    }
    if (statSync(path).mtimeMs < newest) older++;
    if (read.data.made.stepVersion !== BRIEF_STEP_VERSION) oldVersion = read.data.made.stepVersion;
  }
  const n = `${files.length} brief${files.length === 1 ? "" : "s"}`;
  if (older) {
    set(
      spec,
      "stale",
      `${older} of ${n} older than the map or business profile they are made from`,
    );
  } else if (oldVersion !== undefined) {
    set(
      spec,
      "stale",
      `a brief was made by brief version ${oldVersion}; the step is at version ${BRIEF_STEP_VERSION} now`,
    );
  } else set(spec, "ok", n);
}

function actionFor(spec: StepSpec, s: PipelineStepStatus, dir: string): PipelineAction["action"] {
  if (spec.id === "context") return s.state === "waiting" ? "confirm" : "propose";
  if (spec.id === "business") {
    if (s.state === "missing" || s.state === "invalid") return "propose";
    return existsSync(join(dir, OWNER_ANSWERS_FILE)) ? "apply" : "answers";
  }
  return "run";
}

/** "clients/plantpost.example" names its site; "clients/test" doesn't. */
export function hostFromFolder(dir: string): string | null {
  const name = basename(dir).toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) ? name : null;
}
