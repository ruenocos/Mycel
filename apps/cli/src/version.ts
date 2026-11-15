import { execFileSync } from "node:child_process";
import { CORE_VERSION } from "@mycel/core";

let commit: string | null | undefined;

/**
 * The git commit of the code that is running, looked up from where the code is (not from the
 * folder the command was typed in). Null outside a git checkout.
 */
export function codeCommit(): string | null {
  if (commit !== undefined) return commit;
  try {
    commit =
      execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: import.meta.dirname,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
  } catch {
    commit = null; // no git, or not a checkout (an installed package): the version alone is shown
  }
  return commit;
}

/** "0.0.0+a07b883": the version in the JSON output, so a result names the code that made it. */
export function cliVersion(): string {
  const c = codeCommit();
  return c ? `${CORE_VERSION}+${c}` : CORE_VERSION;
}

/** What `mycel --version` prints. */
export function versionLine(): string {
  const c = codeCommit();
  return c ? `${CORE_VERSION} (commit ${c})` : CORE_VERSION;
}
