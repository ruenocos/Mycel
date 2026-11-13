# Mycel: build rules

Read this before changing anything. The plan lives outside the repo (see README). Settled decisions are in `docs/adr/`; don't reopen them without writing a new ADR.

## Product in one line
A topical-map-first SEO tool for Dutch SMBs. Data first, LLM second. A human approves everything (autopilot level 1).

## Rules
- **Generic, never client-specific.** No De Saak (or any client) logic in code. Client differences live in the context/profile only. Every pipeline change must still work for De Saak, Plantpost and Praktijk Beweegruimte.
- **Logic in `packages/core`.** CLI, web and jobs are thin shells around it.
- **Step contract.** Each step: typed input, `run()`, Zod-validated output. Invalid output is retried or stops the run; never pass it on silently.
- **Cache every paid call.** DataforSEO responses are stored by request hash. Live SERP calls only behind an explicit flag. Every run writes a cost file and must stay under its budget.
- **Log every AI/API call:** run ID, step, model + version, prompt version, input hash, tokens, cost, duration, errors/retries. `--debug` writes full prompt/response to `runs/<run-id>/<step>/`.
- **Facts are supplied to the model, never taken from its memory.**
- **User decisions survive re-runs** through the override layer; each run shows a diff against the previous one.
- **Dutch first**, but no hardcoded language/country: market (country, language, city) comes from the context.

## Never commit
Client data (GSC exports, crawls, baselines, `runs/`), API keys or `.env` files, personal notes (`_notities-wons/`), research dumps.

## Workflow
- Branch per issue, PR into `main`, conventional commit prefixes (`feat(core)`, `fix(connectors)`, `chore`, `spike`).
- Plan by order and exit criteria (phase gates), not by hours.
- Ask Wons for input as multiple-choice decisions with one recommended option.
