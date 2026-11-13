# 0011 Quality yardstick: 23-step rubric + data checks; no staging until phase 5

**Status:** accepted, 13 Nov 2026 · changes the "golden set" layer of the plan's quality gates

**Context:** the plan assumed a golden set: Wons's own hand-made De Saak architecture as the bar to beat. Wons is new to SEO, so there is no expert handwork to compare against. The pilot criterion (De Saak OK, #3) is that the map holds up against industry standards / Koray's 23 steps.

**Decision:**
- The De Saak map is judged by a **23-step rubric** (one check per covered Koray step, auto-scored by an LLM judge using the rubric as prompt, plus Wons's yes/no per item at the phase 2 gate) and **data checks** against the 13 Nov baseline: coverage of non-brand GSC queries, known cannibalisation flagged, money pages as core nodes, the noise filter dropping Erp-the-village queries.
- Measures are fixed before run 1; thresholds are set after run 1 and then frozen. An outside SEO review stays optional at the gate.
- **No staging copy until phase 5.** Phases 1-4 only read the live site through the public WP REST API. Writes are WP drafts only (pilot OK). Staging is decided at the start of phase 5 (#4).

**Why:** a yardstick that matches the pilot's own success criterion, costs nothing, and doesn't depend on expertise Wons doesn't have yet. Staging adds setup work with no benefit while nothing writes to WordPress.
