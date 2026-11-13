# Mycel

Mycel helps Dutch SMB owners and content marketers automate SEO with AI, starting with a data-driven topical map. A human signs off on everything.

**Status:** phase 0.5, ready to build. Nothing here runs yet. The first target is a terminal tool that builds a topical map for De Saak (desaak.com, the first pilot) and for two fictional test clients, Plantpost and Praktijk Beweegruimte.

## What lives where

| Where | What |
| --- | --- |
| This repo | Product code, build rules (`CLAUDE.md`), decision records (`docs/adr/`), and test fixtures |
| Project files (Claude project) | Research (Dutch), the De Saak baseline, and Wons's personal notes |
| Claude Docs | The living plan: [product plan v1](https://claude.ai/artifact/RDoAUfXFa45GevMLXx92Ly) and [topical map examples](https://claude.ai/artifact/FQPMxQk48AmEqwvCu8PZju) |

Client data (Search Console exports, crawls, run output) never goes in this repo. See `.gitignore`.

## Planned layout

```
packages/core        all SEO logic, one step per Koray stage
packages/schema      Zod schemas and the step contract
packages/connectors  DataforSEO (cached), GSC, LLM provider switch
apps/cli             the terminal tool (phase 1-2)
apps/web, apps/jobs, apps/wp-plugin   arrive in later phases
docs/adr             one short record per settled decision
```

## Decisions

See [`docs/adr/`](docs/adr/). Settled decisions are not reopened without a new ADR that supersedes the old one.
