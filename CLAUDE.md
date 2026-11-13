# Mycel: build rules

Read this before changing anything. The plan lives outside the repo (see README). Settled decisions are in `docs/adr/`; don't reopen them without writing a new ADR.

## Product in one line
A topical-map-first SEO tool for Dutch SMBs. Data first, LLM second. A human approves everything (autopilot level 1).

## Rules
- **Generic, never client-specific.** No De Saak (or any client) logic in code. Client differences live in the context/profile only. Every pipeline change must still work for De Saak, Plantpost and Praktijk Beweegruimte.
- **Logic in `packages/core`.** CLI, web and jobs are thin shells around it.
- **Step contract.** Each step: typed input, `run()`, Zod-validated output. Invalid output is retried or stops the run; never pass it on silently.
- **Cache every paid call.** DataforSEO responses are stored by request hash. Live SERP calls only behind an explicit flag. Every run writes a cost file and must stay under its budget.
- **Log every AI/API call, exactly (ADR 0009).** Structured JSON logs with `runId` + `step`. LLM calls record provider, exact model + digest, params, prompt template version, prompt hash, tokens, Ollama timings, cost, latency, retries, errors. Full prompt + response are always saved to `runs/<run-id>/<step>/llm/` (secrets redacted). No silent catch blocks: every caught error is logged with context.
- **Facts are supplied to the model, never taken from its memory.**
- **User decisions survive re-runs** through the override layer; each run shows a diff against the previous one.
- **Dutch first**, but no hardcoded language/country: market (country, language, city) comes from the context.

## Never commit
Client data (GSC exports, crawls, baselines, `runs/`), API keys or `.env` files, personal notes (`_notities-wons/`), research dumps.

## Workflow
- Branch per issue, PR into `main`, conventional commit prefixes (`feat(core)`, `fix(connectors)`, `chore`, `spike`). PR title = what changes; body links the issue (`Closes #n`).
- Every issue has a type label, an area label and a milestone (= roadmap phase). A GitHub Release is cut when a phase gate passes (`v0.1.0` = phase 1, `v0.2.0` = phase 2, ...); release notes are generated from PR labels.
- Plan by order and exit criteria (phase gates), not by hours.
- Ask Wons for input as multiple-choice decisions with one recommended option.
