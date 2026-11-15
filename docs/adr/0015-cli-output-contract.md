# 0015 CLI output contract

**Status:** accepted, 15 Nov 2026 (issues #43, #44, #45). Builds on 0001, 0006 and 0009.

**Decision:** every `mycel` command ends the same way, and a caller can rely on four things: where output goes, what the JSON looks like, what the exit code means, and what to do next.

- **One runner.** Every command goes through `runCommand()` (`apps/cli/src/run-command.ts`) and returns a `CommandResult`. It throws `MycelError` with a code and a fix for anything a caller can act on. No command prints its own ending or sets its own exit code.
- **stdout is the result, stderr is everything else.** Progress, logs (`--debug`) and questions go to stderr. Text for people on stdout: the command's summary, one line per step, the files it wrote, the next command with its paths filled in.
- **`--json` on every command.** stdout is then exactly one JSON object, on success and on failure, and nothing else. The schema is `CliOutput` in `packages/schema/src/cli-output.ts`:

  | Field              | What it is                                                                                                |
  | ------------------ | --------------------------------------------------------------------------------------------------------- |
  | `status`           | `"ok"` or `"failed"`                                                                                      |
  | `command`          | the command as typed, e.g. `"eval filter"`                                                                |
  | `version`          | version and git commit of the code, e.g. `"0.0.0+a07b883"`                                                |
  | `exitCode`         | the process exit code; 0 exactly when `status` is `"ok"`                                                  |
  | `runId`            | the run, when there is one (`mycel logs <runId>`)                                                         |
  | `outputs`          | files written, by what they are: `{ "clusters": "clients/x/clusters.json" }`                              |
  | `summary`          | the lines a person would read                                                                             |
  | `data`             | the same result in numbers, for commands that have them (a cost plan, eval scores, the pipeline status)   |
  | `costUsd`, `steps` | what the run cost, and per step: status, duration, cost, model calls, API calls, how many came from cache |
  | `warnings`         | what did not stop the command but colours the result ("trial run", "no pages")                            |
  | `next`             | commands and remarks for what comes after; empty on failure                                               |
  | `error`            | on failure: `code`, `message`, `fix`, `transient` (true when the same command can work a moment later)    |
  | `retry`            | on failure, when there is one: the command that continues without redoing what finished                   |

  **Pointers and numbers, never the dataset.** The data stays in the files `outputs` points to.
- **The contract only grows.** Fields are added, never renamed or removed, and a value never changes meaning. Readers ignore fields they don't know. Changing this takes a new ADR.
- **Exit codes say what kind of failure it was.** 0 done · 1 the run failed · 2 wrong flag or argument · 3 an input is missing, wrong or not confirmed · 4 a key is missing or refused · 5 the command would replace a file a person confirmed · 10 the run worked, but a gate or eval is below its pass mark · 11 budget reached, or a paid call is needed and not allowed · 75 temporary, the same command can work later · 130 / 143 interrupted. Codes are added, never changed. A process that is killed prints no object: its exit code and `mycel logs` tell the rest.
- **`mycel status <client folder>`** answers "where does this client stand" from the folder and the run records: which files are there, what a person still has to confirm, which file is older than the file it was made from or was made by an older version of its step, and the next command. It changes nothing.
- **Money is asked about first.** `--dry-run` on `research` and `cluster` shows the cost without buying; `next` never puts a paid flag in a command to paste. Buying stays a person's call (0006).

**Why:** the main user of the CLI today is Claude driving runs on a PC, and soon scripts and the web shell (0001). Text made for people costs tokens to read, breaks when a word changes, and makes every failure look the same. One exit code for "failed" forces a caller to parse the message to learn whether to retry, fix an input, ask for a key or ask a person about money; a re-run on a wrong guess buys the same data twice.

**Where this differs from the common advice** (bettercli.org and the better-cli rulebook, reviewed for #43):

- **Several exit codes, not only 0 and 1.** Each code is a different next move for the caller, so the split pays for itself. The numbers follow existing habits where there is one (2 usage, 75 temporary, 130 / 143 signals).
- **A short result on success, not silence.** A run costs money and time; the summary, the cost and the next command are the answer the caller came for.
- **No config file, no proxy flags.** Keys live in `.env`, everything else is a flag. Not needed yet.

**Checked by:** `apps/cli/src/json.test.ts` runs every command with `--json`, working and failing, against the schema, and fails when a new command has no case. `apps/cli/src/run-command.test.ts` checks that every command takes `--debug` and follows the pipeline order in the help.
