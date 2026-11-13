# Plantpost: phase 2 gate checklist

Fictional houseplant webshop (B2C, average order around €35). Tests buying intent and the
split between category, product and guide pages.

Machine checks come from `expectations.json`. A human ticks the rest after reading the map.

## Data checks (automatic)

- [ ] Every query in `expectedCore` lands in the core section (or a close variant does).
- [ ] Every topic in `expectedOuter` lands in the outer section.
- [ ] The planted pair `/kamerplanten/grote-kamerplanten/` and `/kamerplanten/xl-planten/` is
      flagged as one conflict, with `merge` as the suggestion.
- [ ] No cluster is built around an `offTopic` term.

## Human checks

- [ ] No Plantpost-specific code or prompt was needed to get this map.
- [ ] Core sits where the money is: categories that sell, not care guides.
- [ ] Category, product and guide pages are not mixed up: a product page is never the target
      for a "how do I" query.
- [ ] Synonyms land on one node: gatenplant = Monstera, vrouwentong = Sansevieria.
- [ ] Seasonal demand (winter care, repotting in spring) shows up as outer nodes, not core.
- [ ] Each existing page is linked to the node it actually serves.
- [ ] Every node has a believable "why" that a plant shop owner would agree with.
