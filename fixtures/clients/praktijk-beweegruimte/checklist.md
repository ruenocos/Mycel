# Praktijk Beweegruimte: phase 2 gate checklist

Fictional physio practice in Utrecht with two locations (Lombok, Leidsche Rijn). Tests local
intent, location × service pages and health facts.

Machine checks come from `expectations.json`. A human ticks the rest after reading the map.

## Data checks (automatic)

- [ ] Every query in `expectedCore` lands in the core section (or a close variant does).
- [ ] Every topic in `expectedOuter` lands in the outer section.
- [ ] The planted pair `/tarieven-en-vergoeding/` and `/blog/hoeveel-fysiotherapie-vergoed/`
      is flagged as one conflict, with `differentiate` as the likely suggestion.
- [ ] No cluster is built around an `offTopic` term (Lombok the island, FC Utrecht, other
      cities, physio courses, animal physio).

## Human checks

- [ ] No Beweegruimte-specific code or prompt was needed to get this map.
- [ ] Core sits where the money is: each service per location, not complaint blogs.
- [ ] Location × service pages follow the QDP rule (only where the SERPs differ), instead of
      every combination by default.
- [ ] Complaints (back pain, RSI, pelvic floor) are outer nodes that link to a service.
- [ ] Insurance facts come from the supplied pages, never from the model's memory.
- [ ] Each existing page is linked to the node it actually serves.
- [ ] Every node has a believable "why" that a physio owner would agree with.
