# 0014 Business profile first

**Status:** accepted, 15 Nov 2026 (issue #42, round 8). Builds on 0002, 0006 and 0011.

**Decision:** the topical map is built from a confirmed business profile, not from the keyword list upward.

- **AI fills in first.** `mycel business propose` reads the site and the research already on disk (GSC, ranked and competitor searches; no paid calls) and fills every field it can prove: offerings with sub-offerings, attributes, audiences, places, price range, proof points and a value tier; what the business does not do; locations and towns served; the conversion; facts; brand terms; the site's own words. Every value cites a page or a search. A value without proof is left out or marked unknown, never guessed. Searches only competitors rank for become questions ("Do you offer X?"), never offerings.
- **The owner confirms in a setup done together.** The owner keeps, corrects or removes each offering, fills only the unknown fields, names the top earners, confirms places and the conversion, and adds what is missing. A removed offering joins the no-go list. Answers arrive as a file (`mycel business apply --answers`, signed with `by`), written from the setup's decision cards or, later, the onboarding screen. The terminal never asks, so nothing hangs without one (ADR 0006: a human approves; no blanket yes).
- **The confirmed profile is the single source.** It sits in `business.json` next to the context. Later steps check against it: the offer gate, places served, the order of the first plan and the facts a page may claim.
- **Test clients:** each has a hand-filled `business.key.json` from its brief, used to score the AI's pre-fill (`mycel business score`). Wons plays the owner of De Saak; for the test clients the owner is played from the key (`mycel business simulate`). Dakwerken's key was written before any round-8 run, so the blind test stays blind.

**Why:** two independent reviews of round 7.1 scored the map 4-6 out of 10. Most of what they found traces back to missing facts, not weak algorithms: pages outside the offer, places not served, a first plan led by search volume, products left outside, claims nobody could back up. Koray's steps 1-6 put the business first; our pipeline collected those answers but only pasted them into prompts.

**Measured by:** `mycel eval map` (fixed numbers per round) and the profile score against the answer keys.
