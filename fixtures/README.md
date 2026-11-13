# Test clients

Two fictional clients that prove the pipeline is generic (ADR 0007). Everything here is
synthetic, so it may live in the repo (ADR 0008). Real client data never goes here.

| Client                  | Type                     | Stress test                                   |
| ----------------------- | ------------------------ | --------------------------------------------- |
| `plantpost`             | Houseplant webshop, B2C  | Buying intent, category vs product vs guide   |
| `praktijk-beweegruimte` | Physio practice, Utrecht | Local intent, location × service, health info |

Each client folder holds:

- `context.json`: the client profile (`ClientContext`), as steps 1-6 would propose it.
- `pages.json`: the existing site (`SitePages`), standing in for the WordPress reader. Page
  structure follows how real Dutch sites in the niche are built; names and text are made up.
- `expectations.json`: the machine half of the phase 2 gate (`GateExpectations`), including
  one planted cannibalisation pair.
- `checklist.md`: the human half of the gate.

Wons approves these fixtures before the first pipeline run. After approval, the answers in
`context.json` move from `proposed` to `confirmed`.
