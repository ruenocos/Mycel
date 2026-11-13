# 0013 English inside, market language out

**Status:** accepted, 13 Nov 2026. Refines the "Dutch first" rule. Builds on 0005 and 0012.

**Decision:** two languages, split by audience.

- **Working language: English.** System prompts, step instructions, model reasoning, intermediate structured data passed between steps (labels, rationales, scores, clusters, briefs meant for the next model call), and logs.
- **Output language: the market language** from the context (`market.language`, Dutch by default). This covers everything a user or reader sees: titles, metas, briefs for people, articles, rewrites, review notes and summaries shown in the app.

**Stays in the original language, untranslated:**

- **Source text passed as facts.** It is quoted as-is with its source id. Translating it first adds a step where facts can drift (ADR 0005: facts are supplied, never invented).
- **Keywords, search queries, SERP titles, entity names and terms of art** (e.g. "onderhanden werk", "meerwerk"). These are data, and the map and the content have to match what people actually search.

**How a prompt looks:** English instructions, then an explicit output line ("Write the answer in Dutch (nl-NL)."), with the language taken from the context, never hardcoded. Style rules for the output language may name that language's own pitfalls.

**Why:** the models have far more English training data, so instructions and reasoning in English tend to be followed more reliably, and English logs are easier to debug. Readers still get native-language text.

**Check before relying on it:** the writing test (#12) used Dutch instructions. Before the writing step switches to English instructions, run a short blind A/B on the same tasks (Dutch vs English instructions, DeepSeek only). The writing step keeps Dutch instructions if the Dutch output gets worse.
