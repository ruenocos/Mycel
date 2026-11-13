# 0005 LLM behind a provider switch

**Status:** accepted, 13 Nov 2026

**Decision:** all model calls go through one provider interface. Start with DeepSeek V4.1 Flash via Ollama Cloud for classification, scoring and labels. The writing model is chosen by a blind Dutch writing test at the end of phase 1. Facts are always supplied in the prompt, never taken from the model's memory. Every call is logged (model, prompt version, tokens, cost).

**Why:** Dutch quality and hallucination are the top product risks; swapping models must be a config change.
