# 0008 No client data or research in the repo

**Status:** accepted, 13 Nov 2026

**Decision:** the repo holds product code, build rules, ADRs and synthetic test fixtures only. Client data (GSC exports, crawls, baselines, run output), research dumps and personal notes stay in the Claude project files. The living plan stays in Claude Docs.

**Why:** client data in git is a privacy risk that can't be undone once pushed, and copied research/plan docs go stale. Keeps the repo clean to track what is actually being built.
