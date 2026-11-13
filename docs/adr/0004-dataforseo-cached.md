# 0004 DataforSEO first, every response cached

**Status:** accepted, 13 Nov 2026

**Decision:** DataforSEO is the first keyword/SERP source. Every response is cached by request hash, live SERP calls run only behind a flag, and each run writes a cost file. Budget: under EUR 50/month in testing, plus a one-off EUR 100 for phase 2. A full De Saak run should cost under $6 and be repeatable from cache. Ahrefs/Semrush are out for now.

**Why:** pay-per-call fits a test budget; caching makes re-runs nearly free and results reproducible.
