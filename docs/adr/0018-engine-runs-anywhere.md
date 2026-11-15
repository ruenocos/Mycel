# 0018 The engine runs anywhere; the platform lives in mycel-dash

**Status:** accepted, 15 Nov 2026 (issues #54-#60). Supersedes the layout part of 0001 (`apps/web`, `apps/jobs` in this repo). Builds on 0001, 0009 and 0015.

**Decision:** this repo stays the single home of the SEO logic and the CLI. The web platform (web app, jobs, database) lives in `ruenocos/mycel-dash` and uses the engine as versioned packages.

- **Packages:** `schema`, `core`, `connectors` (and `runner`, issue #57) are published to GitHub Packages as `@ruenocos/mycel-<name>`, because GitHub Packages only takes a scope that is the account's name. Code keeps importing `@mycel/<name>`: dependencies are pnpm aliases (`"@mycel/schema": "workspace:@ruenocos/mycel-schema@*"`), which publish as `npm:@ruenocos/mycel-schema@<version>`. A consumer installs `"@mycel/core": "npm:@ruenocos/mycel-core@<version>"`.
- **One version for all**, kept in step by Changesets (`fixed` group). The minor number is the last phase gate passed (0.1 = phase 1, 0.2 = phase 2, as the releases), the patch number counts engine releases in between. `CORE_VERSION` and `CONNECTORS_VERSION` are read from `package.json`.
- **Source in the repo, build for consumers.** Inside the repo packages resolve to `src/` (no build needed for the CLI or tests); `publishConfig.exports` points consumers at `dist/` (tsdown: ESM + types).
- **Releasing:** `pnpm changeset` in the PR that changes an engine package; `pnpm changeset version` in a "Version packages" PR; then the "Release packages" workflow (or `pnpm release` locally with a token that can write packages).
- **Storage through ports** (issue #55): runs, cache, ledger and queued tasks go through interfaces whose file implementations stay the default, so the CLI behaves as before.

**Why:** the platform needs to run the same code from a background worker and store its output in a database, without copying logic. Published, versioned packages build on Vercel and Trigger.dev, where private git submodules don't; a separate repo keeps web dependencies, deploys and secrets out of the engine.

**Measured by:** every PR in the move leaves the `--json` suite and the `mycel eval map` numbers unchanged.
