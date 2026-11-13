# 0001 TypeScript monorepo, logic in core, CLI first

**Status:** accepted, 13 Nov 2026

**Decision:** pnpm monorepo with `packages/core`, `packages/schema` (Zod), `packages/connectors` and `apps/cli`. All SEO logic lives in core; CLI, dashboard and background jobs are thin shells. The CLI comes first; the dashboard only after the map is proven (phase 2 gate). The UI framework (React + shadcn vs Vue + Reka UI) is decided before phase 4.

**Why:** nothing gets built twice, and map quality can be proven before any UI work. Solo build with Claude Code, which is fluent in TS.
