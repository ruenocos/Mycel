# 0010 SERPs via the standard queue, with a breadcrumb fallback for goto URLs

**Status:** accepted, 13 Nov 2026 · extends 0003 and 0004

**Context:** Google now serves `google.com/goto?url=...` redirect links in organic results. In the De Saak baseline (live advanced mode), **91 of 91** organic URLs came back as goto links, so SERP-overlap clustering (ADR 0003) had no real URLs to compare. DataforSEO resolves goto URLs in its standard-priority queue; live and high-priority modes leave many unresolved.

**Decision:**

- Organic SERPs use `task_post` + `task_get/advanced` (standard queue). It's also cheaper than live; clustering doesn't need instant answers.
- When a result still only has a goto link, its overlap key is rebuilt from the breadcrumb (host + path, truncated segments marked `…`), else the domain. Each result records `urlSource` (`url` / `breadcrumb` / `domain`) and every SERP counts `unresolvedUrls`, so step 10 can down-weight or flag weak overlaps.

**Why:** without real URLs, "3+ shared URLs" degrades into "3+ shared domains", which would merge pages that only share a big site like a vendor homepage.
