# 0012 DeepSeek V4.1 Flash writes the Dutch content

**Status:** accepted, 13 Nov 2026. Settles the open writing-model question in 0005.

**Decision:** DeepSeek V4.1 Flash (Ollama Cloud) is the writing model for titles, metas, briefs, articles, B1 rewrites and factual answers, as well as for classification. Gemma 4 31B and Mistral Large 4 are not used for writing.

**Evidence:** blind test (issue #12) on 20 De Saak tasks with all sources supplied. Across 20 blind picks, DeepSeek was preferred 11 times, Mistral 6 and Gemma 3. A check of all 20 DeepSeek answers against their sources found no invented facts. Two small slips were found: a made-up link title in one brief, and one wrong word in an article. Mistral returned empty answers on 3 tasks because it spent the whole response on thinking. The run ids and model digests are in the run log, not in the repo (ADR 0008).

**Watch:** the long-form answers stay very close to the wording of the source. A future article step must ask for original wording so the result does not duplicate existing pages.
