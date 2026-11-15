import type { ClientContext } from "@mycel/schema";
import { z } from "zod";
import type { JsonModel } from "../context/llm.ts";
import type { StepContext } from "../log/run-store.ts";
import { pool } from "../research/collect.ts";
import type { MapPlan, NodeDraft } from "./plan.ts";
import { READABLE_KINDS } from "./rules.ts";
import { linkablePages, type PageRef, scorePages } from "./site.ts";

/**
 * Step 15 (issue #19): link the client's existing pages to the map, page by page. Each existing
 * page picks the one map page whose search it serves, from the whole list, so meaning counts
 * ("Tarieven en vergoeding" serves "kosten fysiotherapie", "XL planten" serves "grote
 * kamerplanten"). Two existing pages on one map page is the cannibalisation the owner must see.
 * Word matches are only hints; the model may also say a page serves none of them (legal, jobs).
 */

export const LINK_TEMPLATE = { id: "map-link", version: "3" } as const;

export const LinkAnswer = z.object({
  results: z.array(
    z.object({
      p: z.number().int().nonnegative(),
      /** A map page id ("n12"), or "none". */
      node: z.string().max(12).nullish(),
      /** A second map page this page clearly competes for too, if any. */
      also: z.string().max(12).nullish(),
      /** Only for pages given as kind "other": what the page is. */
      kind: z.string().max(20).nullish(),
    }),
  ),
});
export type LinkAnswer = z.infer<typeof LinkAnswer>;

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
    'Give "also" only when the page clearly competes for a second map page\'s search too, so a visitor searching it could land on either page (a "winter tyres" category next to "snow tyres"; a "how to choose a laptop" guide next to "best laptops"). Leave it out otherwise; a page merely related to its parent topic is not competing.',
    '"likely" lists map pages that share words with the page: hints only, often wrong.',
    `For a page given as kind "other", also say what it is: "service" (something the business does or offers, including a solution or add-on it sells), "category" (a group of products, or a page for one customer group or sector), "location", "product", "pricing", "blog" (an article or customer story), "guide" or "other".`,
    'Answer with JSON: {"results":[{"p":0,"node":"n12","also":"n4","kind":"service"}]}. Answer every number exactly once.',
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
 * Asks the model, in batches, which map page each existing page serves. Returns links: url →
 * node id (or null for "none"), and also: url → a second node it competes for. A page the model
 * skipped after a retry falls back to the word score, and the count is logged.
 */
export async function linkPages(
  llm: JsonModel,
  plan: MapPlan,
  pages: PageRef[],
  opts: { model: string; concurrency: number; batchSize?: number },
  ctx: StepContext,
): Promise<PageLinks> {
  const out = new Map<string, string | null>();
  const also = new Map<string, string>();
  const kinds = new Map<string, PageRef["kind"]>();
  const linkable = linkablePages(pages);
  if (!linkable.length) return { links: out, also, kinds };
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
    const gotAlso = new Map<string, string>();
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
        const kind = r.kind?.trim().toLowerCase();
        if (item.page.kind === "other" && kind && READABLE_KINDS.has(kind as PageRef["kind"])) {
          kinds.set(item.page.url, kind as PageRef["kind"]);
        }
        const pick = r.node?.trim() ?? "";
        if (pick === "none") got.set(item.page.url, null);
        else if (byKey.has(pick)) got.set(item.page.url, (byKey.get(pick) as NodeDraft).id);
        else {
          invalid++;
          continue;
        }
        const second = byKey.get(r.also?.trim() ?? "");
        if (second && pick !== "none" && second.id !== got.get(item.page.url)) {
          gotAlso.set(item.page.url, second.id);
        }
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
    for (const [url, id] of gotAlso) if (out.get(url)) also.set(url, id);
    ctx.log.info("existing pages linked", {
      entity,
      pages: items.length,
      linked: [...got.values()].filter(Boolean).length,
      competing: gotAlso.size,
    });
  }
  return { links: out, also, kinds };
}

export interface PageLinks {
  /** Existing page URL → the node it serves, or null for none. */
  links: Map<string, string | null>;
  /** Existing page URL → a second node it competes for. */
  also: Map<string, string>;
  /** Untyped ("other") page URL → the kind the model read from it. */
  kinds: Map<string, PageRef["kind"]>;
}
