import type { ClientContext, SiteMaps } from "@mycel/schema";
import { z } from "zod";
import type { JsonModel } from "../context/llm.ts";
import type { StepContext } from "../log/run-store.ts";
import type { PageRef } from "./site.ts";

/**
 * Cannibalisation advice (Koray step 15). Data finds the pages that compete for one search; only
 * meaning tells whether they are one page written twice ("Grote kamerplanten" and "XL planten":
 * merge) or two different pages that touch the same search (two sector pages, a care guide on
 * repotting and one on winter care: keep both and give each its own angle).
 */

export const CONFLICT_TEMPLATE = { id: "map-conflict", version: "1" } as const;

export const ConflictAnswer = z.object({
  results: z.array(
    z.object({
      c: z.number().int().nonnegative(),
      suggestion: z.enum(["merge", "differentiate"]).nullish(),
    }),
  ),
});
export type ConflictAnswer = z.infer<typeof ConflictAnswer>;

export function buildConflictMessages(
  ctx: ClientContext,
  items: { search: string; pages: PageRef[] }[],
) {
  const system = [
    "You advise a business on its own web pages that compete for the same search.",
    'For each numbered conflict answer "merge" when the pages cover the same topic for the same visitor (one page written twice, e.g. "Large plants" and "XL plants"): combine them into one and redirect the other.',
    'Answer "differentiate" when they are different pages that only touch the same search: different customer groups or sectors, different services, different questions (repotting vs winter care), or an article next to an offer page. Then both stay, each with its own angle.',
    "When in doubt, answer differentiate: merging removes a page.",
    'Answer with JSON: {"results":[{"c":0,"suggestion":"merge"}]}. Answer every number exactly once.',
  ].join("\n");
  const list = items.map((it, c) => ({
    c,
    search: it.search,
    pages: it.pages.map((p) => ({ url: p.url, kind: p.kind, title: p.title, h1: p.h1 })),
  }));
  return [
    { role: "system" as const, content: system },
    {
      role: "user" as const,
      content: `Business: ${ctx.site.name} (${ctx.sourceContext})\n\nConflicts:\n${JSON.stringify(list, null, 1)}`,
    },
  ];
}

/**
 * Asks the model once per map to judge each conflict; a conflict it skips keeps the rule-based
 * advice from finish.ts, and the count is logged. Changes the maps in place.
 */
export async function judgeConflicts(
  llm: JsonModel,
  maps: SiteMaps,
  ctx: ClientContext,
  pages: PageRef[],
  opts: { model: string },
  step: StepContext,
): Promise<void> {
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  for (const map of maps.maps) {
    const nodes = map.nodes.filter((n) => n.conflict);
    if (!nodes.length) continue;
    const items = nodes.map((n) => ({
      search: n.mainQuery,
      pages: (n.conflict?.urls ?? []).map(
        (url) => byUrl.get(url) ?? { url, kind: "other" as const, title: url, h1: url },
      ),
    }));
    const answer = await llm.generateJson(
      {
        model: opts.model,
        template: CONFLICT_TEMPLATE,
        messages: buildConflictMessages(ctx, items),
        params: { temperature: 0, seed: 41 },
      },
      ConflictAnswer,
      step,
    );
    let judged = 0;
    let changed = 0;
    for (const r of answer.results) {
      const n = nodes[r.c];
      if (!n?.conflict || !r.suggestion) continue;
      judged++;
      if (n.conflict.suggestion !== r.suggestion) changed++;
      n.conflict.suggestion = r.suggestion;
    }
    if (judged < nodes.length) {
      step.log.warn("model skipped conflicts; rule-based advice kept", {
        entity: map.header.centralEntity.name,
        skipped: nodes.length - judged,
      });
    }
    step.log.info("conflicts judged", {
      entity: map.header.centralEntity.name,
      conflicts: nodes.length,
      changed,
    });
  }
}
