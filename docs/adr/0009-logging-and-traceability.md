# 0009 Logging and traceability for every AI and API call

**Status:** accepted, 13 Nov 2026

**Decision:** every run must be reproducible and debuggable after the fact, without re-running it. Concretely:

- **Structured logs** (JSON lines, one logger for the whole codebase) with a `runId` and `step` on every line. Levels: debug, info, warn, error.
- **Every LLM call** (Ollama first) records: provider, endpoint, exact model name _and_ digest/version as reported by the provider, parameters (temperature, top_p, seed, max tokens, format/JSON mode), prompt template id + version, hash of the rendered prompt, tokens in/out, Ollama timings (`total_duration`, `load_duration`, `prompt_eval_count`, `eval_count`, `done_reason`), cost, latency, retries and the error if any.
- **Full prompt and full response are always saved** to `runs/<run-id>/<step>/llm/<call-id>.json` (local, gitignored), not only with `--debug`. Secrets and API keys are redacted before writing. `--debug` additionally mirrors them to the console.
- **Every paid API call** (DataforSEO, later GSC) records endpoint, request hash, cache hit/miss, cost, latency and status.
- **Each run writes** `runs/<run-id>/run.json`: git commit, CLI version, config, client, start/end, per-step status, total cost, and the error with stack trace if it failed.
- A `mycel logs <run-id>` command (phase 1) prints a readable timeline of a run, so troubleshooting doesn't mean reading raw JSON.

**Why:** LLM output is non-deterministic and Ollama models change under the same name. To explain a bad map node weeks later, we need the exact model, prompt and response that produced it. Disk is cheap; a lost trace isn't recoverable.
