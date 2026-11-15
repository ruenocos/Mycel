# Architecture decision records

One short file per settled decision. To change a decision, add a new ADR that supersedes the old one; don't edit history.

| #    | Decision                                                                  |
| ---- | ------------------------------------------------------------------------- |
| 0001 | TypeScript monorepo, logic in core, CLI first                             |
| 0002 | Topical map first, Koray method from public material, data before LLM     |
| 0003 | Clustering by SERP overlap (3+ shared top-10 URLs)                        |
| 0004 | DataforSEO first, every response cached                                   |
| 0005 | LLM behind a provider switch, facts always supplied                       |
| 0006 | Human review by default (autopilot level 1)                               |
| 0007 | Generic pipeline, proven on three test clients                            |
| 0008 | No client data or research in the repo                                    |
| 0009 | Logging and traceability for every AI and API call                        |
| 0010 | SERPs via the standard queue, breadcrumb fallback for goto URLs           |
| 0011 | Quality yardstick: 23-step rubric + data checks; no staging until phase 5 |
| 0012 | DeepSeek V4.1 Flash writes the Dutch content (writing test #12)           |
| 0013 | English inside (prompts, reasoning, step data), market language out       |
| 0014 | Business profile first: AI fills in with proof, the owner confirms       |
