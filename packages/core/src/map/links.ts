import type { LinkOut } from "@mycel/schema";
import { termSimilarity, termWeights } from "../cluster/cluster.ts";
import type { NodeDraft } from "./plan.ts";

/**
 * Link plan (Koray step 20): up to the core, hub to its pages, siblings, home to its quality
 * nodes (step 13), and 3 topical bridges between top-level hubs.
 */
export function linkPlan(input: {
  nodes: NodeDraft[];
  root: NodeDraft;
  parent: Map<string, string>;
  /** Value of a page, for which children and siblings get linked first. */
  score: (n: NodeDraft) => number;
  quality: Set<string>;
}): (n: NodeDraft) => LinkOut[] {
  const { nodes, root, parent, score, quality } = input;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, NodeDraft[]>();
  for (const [id, p] of parent) {
    const n = byId.get(id);
    if (n) children.set(p, [...(children.get(p) ?? []), n]);
  }
  const isSeed = (n: NodeDraft) => parent.get(n.id) === root.id;
  const weights = termWeights(nodes.map((n) => [n.mainQuery, ...n.queries].join(" ")));
  const text = (n: NodeDraft) => [n.mainQuery, ...n.queries].join(" ");
  const seeds = nodes.filter(isSeed);
  const nearestCore = (n: NodeDraft): NodeDraft => {
    let p = byId.get(parent.get(n.id) ?? "");
    while (p && !p.isRoot && p.section !== "core") p = byId.get(parent.get(p.id) ?? "");
    return p ?? root;
  };
  return (n) => {
    const out: LinkOut[] = [];
    const seen = new Set<string>([n.id]);
    const add = (to: NodeDraft | undefined, type: LinkOut["type"]) => {
      if (!to || seen.has(to.id)) return;
      seen.add(to.id);
      out.push({ to: to.id, type, anchor: to.name ?? to.mainQuery });
    };
    if (!n.isRoot) {
      const p = byId.get(parent.get(n.id) ?? "") as NodeDraft;
      add(p, p.section === "core" ? "to_core" : "parent");
      if (n.section === "outer" && p.section !== "core") add(nearestCore(n), "to_core");
    }
    // Home links its quality nodes as such (step 13), before its other children.
    if (n.isRoot) for (const id of quality) add(byId.get(id), "from_home");
    const kids = [...(children.get(n.id) ?? [])].sort((a, b) => score(b) - score(a));
    for (const k of kids.slice(0, 12)) add(k, "child");
    // Seeds are all siblings under the root: they get topical bridges instead (below).
    if (!n.isRoot && !isSeed(n)) {
      const sibs = (children.get(parent.get(n.id) ?? "") ?? [])
        .filter((s) => s !== n)
        .sort(
          (a, b) =>
            (a.section === n.section ? 0 : 1) - (b.section === n.section ? 0 : 1) ||
            score(b) - score(a),
        );
      for (const s of sibs.slice(0, 2)) add(s, "sibling");
    }
    if (isSeed(n)) {
      const near = seeds
        .filter((s) => s !== n)
        .map((s) => ({ s, sim: termSimilarity(text(n), text(s), weights) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 3);
      for (const { s } of near) add(s, "bridge");
    }
    return out;
  };
}
