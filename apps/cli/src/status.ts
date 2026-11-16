import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BUSINESS_PROPOSAL_FILE,
  hostFromFolder,
  MycelError,
  OWNER_ANSWERS_FILE,
  type PipelineAction,
  type PipelineStatus,
  pipelineStatus,
} from "@mycel/core";
import { command } from "./input.ts";
import type { CommandResult, NextStep } from "./run-command.ts";

/**
 * `mycel status <client folder>` (issue #45). Thin shell around core's pipelineStatus(): prints
 * where the client stands and turns "what can be done now" into commands to paste. It reads
 * only; nothing runs and nothing is written.
 */

const PAID = "a paid run: add --dry-run first to see the cost. Buying is a person's call";

function nextStep(status: PipelineStatus, a: PipelineAction): NextStep {
  const file = (step: PipelineAction["step"]) =>
    status.steps.find((s) => s.step === step)?.file ?? "";
  const context = file("context");
  switch (a.step) {
    case "context": {
      if (a.action === "confirm") return { command: command("context confirm", context) };
      const host = hostFromFolder(status.dir);
      return host
        ? { command: command("context propose", `https://${host}`, "--out", context) }
        : { note: `${command("context propose", "<site URL>", "--out", context)}` };
    }
    case "research":
      return { command: command("research", context), note: PAID };
    case "business": {
      const proposed = join(status.dir, BUSINESS_PROPOSAL_FILE);
      const answers = join(status.dir, OWNER_ANSWERS_FILE);
      if (a.action === "apply") {
        return { command: command("business apply", proposed, "--answers", answers) };
      }
      if (a.action === "answers") {
        return {
          note: `the owner's answers to ${proposed} go in ${answers} (the setup writes them); then mycel business apply`,
        };
      }
      return {
        command: command("business propose", context, "--site", status.site ?? "<site URL>"),
      };
    }
    case "filter":
      return { command: command("filter", file("research")) };
    case "cluster":
      return {
        command: command("cluster", file("filter"), "--dry-run"),
        note: "then the same with --live-serp --budget <usd> for what is missing. Buying is a person's call",
      };
    case "signals":
      return {
        command: command("signals", file("cluster"), "--dry-run"),
        note: "then the same without --dry-run ($0, cached data), or with --buy for monthly searches and Google Trends. Buying is a person's call",
      };
    case "map":
      return { command: command("map", file("cluster")) };
  }
}

export function statusRun(opts: { dir: string; runsDir: string }): CommandResult {
  if (!existsSync(opts.dir) || !statSync(opts.dir).isDirectory()) {
    throw new MycelError("INPUT_MISSING", `no client folder at ${opts.dir}`, {
      fix: "pass the folder that holds the client's context.json, e.g. clients/example.com",
    });
  }
  const status = pipelineStatus(opts.dir, { runsDir: opts.runsDir });
  const lines = [`client      ${status.client ?? "(no context yet)"}  in ${status.dir}`];
  for (const s of status.steps) {
    lines.push(`${s.step.padEnd(12)}${s.state.padEnd(9)}${s.detail}`);
  }
  const next: NextStep[] = status.done
    ? [{ note: "nothing to do: every file is there and up to date" }]
    : status.next.map((a) => nextStep(status, a));
  return {
    ok: true,
    lines,
    next,
    data: {
      client: status.client,
      dir: status.dir,
      ...(status.site ? { site: status.site } : {}),
      done: status.done,
      pipeline: status.steps,
      actions: status.next,
    },
  };
}
