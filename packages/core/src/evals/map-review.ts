import type { ClientContext, SiteMaps } from "@mycel/schema";

/**
 * The two-persona map review (issue #42, step 0) as a fixed, versioned template, so reviewer
 * scores compare across rounds. A fresh model or person gets the same brief, rubric and digest
 * every time. The digest is built from the map itself; nothing is summarised by a model first.
 */

export const MAP_REVIEW_TEMPLATE = { id: "map-review", version: "1" } as const;

export const REVIEW_PERSONAS = {
  seo: "an experienced SEO consultant who builds topical maps for Dutch SMB clients and has to defend this plan to the client",
  owner:
    "the owner of this business: you know your offer and customers well but not SEO, and you decide whether to spend the next months on this plan",
} as const;
export type ReviewPersona = keyof typeof REVIEW_PERSONAS;

/** The rubric: five parts scored 1-10, plus one overall score. Changing it means a new version. */
export const REVIEW_RUBRIC = [
  {
    id: "earns",
    question:
      "Does every page earn its place? No two pages for the same search, nothing the business doesn't sell, no places it doesn't serve.",
  },
  {
    id: "first",
    question:
      "Is the first plan what you would actually do first? Does it start where the money and the quick wins are?",
  },
  {
    id: "existing",
    question:
      "Does it build on what the site already has (pages, products, articles) before adding new pages?",
  },
  {
    id: "trust",
    question:
      "Can you trust the names and reasons? Plain words, no jargon, no claims the business can't back up.",
  },
  {
    id: "complete",
    question: "Is every important offering covered, with a clear place in the structure?",
  },
] as const;

const MAX_TREE = 400;

/** A plain-text view of the map: first plan, tree, left out, outside. */
export function mapDigest(maps: SiteMaps, ctx: ClientContext): string {
  const lines: string[] = [
    `Business: ${ctx.site.name} (${ctx.site.url})`,
    `How it earns: ${ctx.sourceContext}`,
    `Market: ${[ctx.market.country, ctx.market.city].filter(Boolean).join(", ")}`,
  ];
  for (const m of maps.maps) {
    const byParent = new Map<string, typeof m.nodes>();
    for (const n of m.nodes) {
      const k = n.parentId ?? "";
      byParent.set(k, [...(byParent.get(k) ?? []), n]);
    }
    const now = m.nodes.filter((n) => n.wave === "now").sort((a, b) => a.priority - b.priority);
    lines.push("", `## Map: ${m.header.centralEntity.name}`, "", "First plan:");
    for (const n of now) {
      lines.push(
        `- [${n.action}] ${n.name ?? n.mainQuery} ${n.proposedUrl} (${n.demand.volume ?? 0}/mo): ${n.why}`,
      );
    }
    lines.push("", "Structure (action, name, URL, monthly searches):");
    let shown = 0;
    const walk = (parent: string, depth: number) => {
      for (const n of byParent.get(parent) ?? []) {
        if (shown++ >= MAX_TREE) return;
        lines.push(
          `${"  ".repeat(depth)}- [${n.action}${n.wave ? `/${n.wave}` : ""}] ${n.name ?? n.mainQuery} ${n.proposedUrl} (${n.demand.volume ?? 0})`,
        );
        walk(n.id, depth + 1);
      }
    };
    walk("", 0);
    if (shown > MAX_TREE) lines.push(`… ${shown - MAX_TREE} more pages`);
    if (m.leftOut.length) {
      lines.push("", "Left out:");
      for (const l of m.leftOut) lines.push(`- ${l.mainQuery} (${l.volume}): ${l.reason}`);
    }
  }
  if (maps.outside.length) {
    lines.push("", "Existing pages outside the map:");
    for (const p of maps.outside) lines.push(`- ${p.url} (${p.kind}) ${p.title}`);
  }
  return lines.join("\n");
}

/** The full review prompt for one persona. The answer is JSON so scores can be compared. */
export function mapReviewPrompt(
  persona: ReviewPersona,
  maps: SiteMaps,
  ctx: ClientContext,
): string {
  return [
    `You are ${REVIEW_PERSONAS[persona]}.`,
    "Review this topical map and its first plan for usability. Judge only what is in front of you.",
    "",
    "Score each part from 1 to 10 and give one overall score:",
    ...REVIEW_RUBRIC.map((r) => `- ${r.id}: ${r.question}`),
    "",
    'Answer as JSON: {"scores": {"earns": n, "first": n, "existing": n, "trust": n, "complete": n}, "overall": n, "worst": [up to 5 concrete problems, each naming the page], "best": [up to 3 things that work]}',
    "",
    mapDigest(maps, ctx),
  ].join("\n");
}
