import { existsSync, readFileSync } from "node:fs";
import { MycelError } from "@mycel/core";
import type { ClientContext } from "@mycel/schema";
import type { z } from "zod";
import { describeIssues } from "./errors.ts";

/** What a command reads: how to name the file in an error, and which command writes it. */
export interface InputKind {
  /** "clusters file", "context" */
  name: string;
  /** "mycel cluster" */
  writtenBy: string;
}

/**
 * Reads and validates one input file. A missing or wrong file is the most common mistake at the
 * terminal, so it gets a sentence and a fix instead of a stack trace or the validator's raw output.
 */
export function readInput<S extends z.ZodType>(
  path: string,
  schema: S,
  kind: InputKind,
): z.output<S> {
  if (!existsSync(path)) {
    throw new MycelError("INPUT_MISSING", `no ${kind.name} at ${path}`, {
      fix: `run ${kind.writtenBy} first, or pass the path of the file it wrote`,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new MycelError("INPUT_INVALID", `${path} is not valid JSON: ${(err as Error).message}`, {
      fix: `pass the file that ${kind.writtenBy} wrote`,
      cause: err,
    });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new MycelError(
      "INPUT_INVALID",
      `${path} is not a ${kind.name} (${describeIssues(parsed.error)})`,
      { fix: `pass the file that ${kind.writtenBy} wrote`, cause: parsed.error },
    );
  }
  return parsed.data;
}

/** Later steps run on a context a person confirmed (ADR 0006), unless a trial run is asked for. */
export function assertConfirmed(context: ClientContext, file: string, allowUnconfirmed = false) {
  if (context.confirmed || allowUnconfirmed) return;
  throw new MycelError("NOT_CONFIRMED", `${file} isn't confirmed yet`, {
    fix: `run ${command("context confirm", file)} first (or add --allow-unconfirmed for a trial run)`,
  });
}

/** A path as it can be pasted back into a shell: quoted when it has spaces. */
export const shellArg = (s: string) =>
  /[\s"'&|<>()]/.test(s) ? `"${s.replaceAll('"', '\\"')}"` : s;

/** `mycel <name> <args>`, ready to paste. */
export const command = (name: string, ...args: string[]) =>
  ["mycel", name, ...args.map(shellArg)].join(" ");
