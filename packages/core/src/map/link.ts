import type { ClientContext } from "@mycel/schema";
import { z } from "zod";
import type { JsonModel } from "../context/llm.ts";
import type { StepContext } from "../log/run-store.ts";
import { pool } from "../research/collect.ts";
import { type MapPlan, type NodeDraft, type PageRef, scorePages } from "./build.ts";

/**
 * Step 15 (issue #19): link the client's existing pages to the map, page by page. Each existing
 * page picks the one map page whose search it serves, from the whole list, so meaning counts
 * ("Tarieven en vergoeding" serves "kosten fysiotherapie", "XL planten" serves "grote
 * kamerplanten"). Two existing pages on one map page is the cannibalisation the owner must see.
 * Word matches are only hints; the model may also say a page serves none of them (legal, jobs).
 */

export const LINK_TEMPLATE = { id: "map-link", version: "1" } as const;

export const LinkAnswer = z.object({
  results: z.array(
    z.object({
      p: z.number().int().nonnegative(),
      /** A map page id ("n12"), or "none". */
      node: z.string().max(12).nullish(),
    }),
  ),
});
export type LinkAnswer = z.infer<typeof LinkAnswer>;

const SKIP = new Set(["home", "about", "contact"]);

/** Existing pages the model judges: everything but the homepage, about and contact pages. */
export const linkablePages = (pages: PageRef[]) =>
  pages.filter((p) => p.url !== "/" && !SKIP.has(p.kind));

export function buildLinkMessages(
  ctx: ClientContext,
  entity: string,
  nodes: NodeDraft[],
  batch: { page: PageRef; likely: string[] }[],
) {
  const system = [
    `You link a business's existing web pages to its topical map about "${entity}". The map lists the pages the site should have, each by its main search.`,
    "For each numbered existing page, pick the one map page whose search it serves: the search a visitor would type to land on it. Judge meaning, not shared words: different words can mean the same search (prices = costs = rates, XL = large, reimbursed = covered by insurance).",
    'A category, service or pricing page serves the general or buying search; a blog or guide serves the question it answers. A page about one product, one town or one person serves that narrower search, not the general one. Use "none" when no map page fits (legal pages, jobs, news, the team).',
    "Several existing pages may pick the same map page when they really target the same search: that is cannibalisation, so report it honestly rather than spreading pages out.",
    '"likely" lists map pages that share words with the page: hints only, often wrong.',
    'Answer with JSON: {"results":[{"p":0,"node":"n12"}]}. Answer every number exactly once.',
  ].join("\n");
  const map = nodes
    .map((n, i) => `n${i}: ${n.mainQuery} (${n.isRoot ? "home" : n.section})`)
    .join("\n");
  const pages = batch.map((b, p) => ({
    p,
    url: b.page.url,
    kind: b.page.kind,
    title: b.page.title,
    h1: b.page.h1,
    ...(b.likely.length ? { likely: b.likely } : {}),
  }));
  return [
    { role: "system" as const, content: system },
    {
      role: "user" as const,
      content: `Business: ${ctx.site.name} (${ctx.sourceContext})\n\nMap pages:\n${map}\n\nExisting pages:\n${JSON.stringify(pages, null, 1)}`,
    },
  ];
}

/**
 * Asks the model, in batches, which map page each existing page serves. Returns url → node id
 * (or null for "none"), per entity. A page the model skipped after a retry falls back to the
 * word score, and the count is logged.
 */
export async function linkPages(
  llm: JsonModel,
  plan: MapPlan,
  pages: PageRef[],
  opts: { model: string; concurrency: number; batchSize?: number },
  ctx: StepContext,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const linkable = linkablePages(pages);
  if (!linkable.length) return out;
  const size = opts.batchSize ?? 20;
  for (const { entity, nodes } of plan.entities) {
    const scores = scorePages(nodes, linkable, plan.context);
    const key = new Map(nodes.map((n, i) => [n.id, `n${i}`]));
    const byKey = new Map(nodes.map((n, i) => [`n${i}`, n]));
    const likely = (url: string) =>
      [...(scores.get(url) ?? [])]
        .filter(([, s]) => s.score >= 0.5 && s.h1 > 0)
        .sort((a, b) => b[1].score + b[1].h1 - (a[1].score + a[1].h1))
        .slice(0, 5)
        .map(([id]) => key.get(id) as string);
    const items = linkable.map((page) => ({ page, likely: likely(page.url) }));
    const batches: (typeof items)[] = [];
    for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
    let invalid = 0;
    const got = new Map<string, string | null>();
    const ask = async (batch: typeof items, seed: number) => {
      const answer = await llm.generateJson(
        {
          model: opts.model,
          template: LINK_TEMPLATE,
          messages: buildLinkMessages(plan.context, entity, nodes, batch),
          params: { temperature: 0, seed },
        },
        LinkAnswer,
        ctx,
      );
      for (const r of answer.results) {
        const item = batch[r.p];
        if (!item || got.has(item.page.url)) continue;
        const pick = r.node?.trim() ?? "";
        if (pick === "none") got.set(item.page.url, null);
        else if (byKey.has(pick)) got.set(item.page.url, (byKey.get(pick) as NodeDraft).id);
        else invalid++;
      }
    };
    await pool(batches, opts.concurrency, (b) => ask(b, 21));
    const missing = items.filter((x) => !got.has(x.page.url));
    if (missing.length) {
      ctx.log.warn("model skipped existing pages, asking again", { count: missing.length });
      const again: (typeof items)[] = [];
      for (let i = 0; i < missing.length; i += size) again.push(missing.slice(i, i + size));
      await pool(again, opts.concurrency, (b) => ask(b, 22));
    }
    const left = items.filter((x) => !got.has(x.page.url)).length;
    if (left) ctx.log.warn("existing pages left to the word score after a retry", { count: left });
    if (invalid) ctx.log.warn("model named map pages that don't exist", { invalid });
    // Several maps: a page belongs to the map whose page it serves; "none" only if none does.
    for (const [url, id] of got) if (id || !out.has(url)) out.set(url, id);
    ctx.log.info("existing pages linked", {
      entity,
      pages: items.length,
      linked: [...got.values()].filter(Boolean).length,
    });
  }
  return out;
}
