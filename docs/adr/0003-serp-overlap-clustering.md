# 0003 Clustering by SERP overlap

**Status:** accepted, 13 Nov 2026

**Decision:** two queries belong on one page when their top-10 results share 3 or more URLs (after URL normalisation, including Google redirect/goto URLs). Plus the Query Deserves a Page rule; outliers are flagged for a human.

**Why:** Google's own results decide what is one intent, not embeddings. Fallback if thin Dutch niches make this shaky: semantic clustering first, validated against the SERP (to be decided in phase 2).
