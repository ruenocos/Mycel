import type { ClientContext } from "@mycel/schema";
import { z } from "zod";
import { variantKey } from "../cluster/cluster.ts";
import type { JsonModel } from "../context/llm.ts";
import { languageName } from "../evals/writing.ts";
import type { StepContext } from "../log/run-store.ts";
import { pool } from "../research/collect.ts";
import { resolveParents } from "./finish.ts";
import type { MapPlan, NodeDraft, NodeLabel } from "./plan.ts";
import { GROUP } from "./rules.ts";
import { slugify } from "./urls.ts";

/**
 * Round 6 (issue #19): too many pages under one parent is a list, not a structure. When home has
 * many loose top-level pages, or a hub has more than GROUP.maxChildren (rules.ts) pages directly under it, the
 * model groups them by theme. A group's head is one of the listed pages that naturally covers
 * the others, or a new hub page with a short name. Data still decides which pages exist; the
 * model only proposes the grouping, and a group needs at least 3 members.
 */

export const GROUP_TEMPLATE = { id: "map-group", version: "1" } as const;

export const GroupAnswer = z.object({
  groups: z.array(
    z.object({
      /** One of the listed pages ("p3") that is the natural hub for the members. */
      head: z.string().max(12).nullish(),
      /** A new hub name when no listed page is the head. */
      name: z.string().max(80).nullish(),
      members: z.array(z.string().max(12)).default([]),
      /** For a new hub: one plain sentence for the owner on why it groups these pages. */
      why: z.string().max(300).nullish(),
    }),
  ),
});
export type GroupAnswer = z.infer<typeof GroupAnswer>;

export function buildGroupMessages(
  ctx: ClientContext,
  entity: string,
  parentName: string,
  pages: NodeDraft[],
) {
  const lang = languageName(ctx.market.language);
  const system = [
    `You organise part of a topical map about "${entity}" for one business. These pages all sit directly under "${parentName}": too many to navigate.`,
    "Group pages that share one theme, the way a visitor would look for them: a buying choice (by size, budget, use), one sub-type or family, one problem, gifts and delivery, costs and insurance. Judge meaning, never shared words alone.",
    `A group's "head" is one of the listed pages that naturally covers the others (its id, e.g. "p3"). When none does, leave head empty and give "name": a short hub page name in ${lang}, in the words people search with, and "why": one plain sentence in ${lang} for the business owner on why this hub page helps (informal singular "you", no jargon).`,
    `Each group needs at least ${GROUP.minMembers} members besides its head. A page belongs to at most one group. Leave a page out of every group when it is a main topic of its own. A core page never goes in a group whose head is an outer page.`,
    'Answer with JSON: {"groups":[{"head":"p3","members":["p1","p7","p9"]},{"name":"...","why":"...","members":["p2","p4","p5"]}]}',
  ].join("\n");
  const list = pages.map((n, i) => ({
    id: `p${i}`,
    page: n.mainQuery,
    tier: n.section,
    volume: n.volume,
    queries: n.queries.slice(0, 4),
  }));
  return [
    { role: "system" as const, content: system },
    {
      role: "user" as const,
      content: `Business: ${ctx.site.name} (${ctx.sourceContext})\n\nPages under "${parentName}":\n${JSON.stringify(list, null, 1)}`,
    },
  ];
}

export interface Grouping {
  themes: NodeDraft[];
  parents: Map<string, string>;
}

/**
 * Groups loose top-level pages and over-wide hubs. Returns, per entity, the new theme hubs and
 * the pages that move under a hub. Invalid answers are dropped and counted in the log.
 */
export async function groupPages(
  llm: JsonModel,
  plan: MapPlan,
  labels: Map<string, NodeLabel>,
  opts: { model: string; concurrency: number },
  ctx: StepContext,
): Promise<Map<string, Grouping>> {
  const out = new Map<string, Grouping>();
  const language = plan.context.market.language;
  for (const { entity, nodes } of plan.entities) {
    const root = nodes[0] as NodeDraft;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const parent = resolveParents(nodes, labels);
    const children = new Map<string, NodeDraft[]>();
    for (const [id, p] of parent) {
      children.set(p, [...(children.get(p) ?? []), byId.get(id) as NodeDraft]);
    }
    const tasks: { under: NodeDraft; pages: NodeDraft[] }[] = [];
    const keep = (n: NodeDraft) => !n.hub && !labels.get(n.id)?.drop;
    const loose = (children.get(root.id) ?? []).filter(keep);
    if (loose.length >= GROUP.minLoose) tasks.push({ under: root, pages: loose });
    for (const [id, kids] of children) {
      if (id !== root.id && kids.length > GROUP.maxChildren) {
        tasks.push({ under: byId.get(id) as NodeDraft, pages: kids.filter(keep) });
      }
    }
    const grouping: Grouping = { themes: [], parents: new Map() };
    const themeByKey = new Map<string, NodeDraft>();
    let dropped = 0;
    await pool(tasks, opts.concurrency, async (task) => {
      const answer = await llm.generateJson(
        {
          model: opts.model,
          template: GROUP_TEMPLATE,
          messages: buildGroupMessages(plan.context, entity, task.under.mainQuery, task.pages),
          params: { temperature: 0, seed: 31 },
        },
        GroupAnswer,
        ctx,
      );
      const pick = (key: string | null | undefined) => {
        const m = /^p(\d+)$/.exec(key?.trim() ?? "");
        return m ? task.pages[Number(m[1])] : undefined;
      };
      for (const g of answer.groups) {
        let head = pick(g.head);
        const members = [...new Set(g.members.map(pick).filter((n): n is NodeDraft => !!n))].filter(
          (n) => n !== head && !grouping.parents.has(n.id),
        );
        if (members.length < GROUP.minMembers || (!head && !g.name?.trim())) {
          dropped++;
          continue;
        }
        if (head && grouping.parents.has(head.id)) {
          dropped++;
          continue;
        }
        if (!head) {
          const name = (g.name as string).trim();
          const key = `${task.under.id}:${variantKey(name, language)}`;
          head = themeByKey.get(key);
          if (!head) {
            head = themeNode(entity, name, members, task.under, g.why?.trim());
            themeByKey.set(key, head);
            grouping.themes.push(head);
            if (task.under !== root) grouping.parents.set(head.id, task.under.id);
          }
        }
        for (const m of members) {
          if (m.section === "core" && head.section === "outer") continue;
          grouping.parents.set(m.id, head.id);
        }
      }
    });
    if (dropped) ctx.log.warn("model groups dropped (too small or invalid)", { entity, dropped });
    ctx.log.info("pages grouped", {
      entity,
      tasks: tasks.length,
      themes: grouping.themes.map((t) => t.mainQuery),
      moved: grouping.parents.size,
    });
    out.set(entity, grouping);
  }
  return out;
}

/** A new hub page for a theme: core when any member is core, demand summed from its members. */
function themeNode(
  entity: string,
  name: string,
  members: NodeDraft[],
  under: NodeDraft,
  why?: string,
): NodeDraft {
  const core = members.some((m) => m.section === "core");
  const votes = new Map<string, number>();
  for (const m of members) {
    votes.set(m.intent.main, (votes.get(m.intent.main) ?? 0) + Math.max(1, m.volume));
  }
  const main = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "informational";
  return {
    id: `theme-${slugify(under.isRoot ? name : `${under.mainQuery} ${name}`)}`,
    entity,
    isRoot: false,
    section: core ? "core" : "outer",
    mainQuery: name,
    name: name.charAt(0).toUpperCase() + name.slice(1),
    queries: [],
    sections: [],
    volume: 0,
    gscImpressions: 0,
    intent: { main: main as NodeDraft["intent"]["main"], mixed: false, source: "tier" },
    aiOverview: null,
    hub: "theme",
    // The model's line, in the owner's language; empty when it gave none, so the finish writes a
    // plain one from data (check.ts plainWhy).
    qdpWhy: why && why.length >= 10 ? why : "",
  };
}
