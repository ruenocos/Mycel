import { MIN_SHARED_URLS } from "@mycel/schema";
import { type ClusterSerp, overlapKeys } from "../cluster/cluster.ts";
import type { MapPlan, NodeDraft } from "./plan.ts";

/**
 * Issue #42, step 4: one page per intent. Two pages whose main searches share 3+ top-10 results
 * (ADR 0003) answer the same search: the smaller becomes a section of the bigger, with the shared
 * URLs kept as proof. The root and the offering pages always stay; two offering pages are never
 * merged (the owner named both). SERPs come from the cache; pages without one are left as they are.
 */

export interface IntentMerge {
  kept: string;
  folded: string;
  sharedUrls: string[];
}

export function mergeSameIntent(
  plan: MapPlan,
  serps: Map<string, ClusterSerp>,
  locked: Set<string> = new Set(),
  skip: Set<string> = new Set(),
): IntentMerge[] {
  const merges: IntentMerge[] = [];
  for (const e of plan.entities) {
    // Keep order: root, then offering pages, then by demand.
    const rank = (n: NodeDraft) => (n.isRoot ? 2 : locked.has(n.id) ? 1 : 0);
    const withSerp = e.nodes
      .filter((n) => !skip.has(n.id) && serps.has(n.mainQuery))
      .map((n) => ({ n, keys: overlapKeys(serps.get(n.mainQuery) as ClusterSerp) }))
      .filter((x) => x.keys.size > 0)
      .sort((a, b) => rank(b.n) - rank(a.n) || b.n.volume - a.n.volume);
    const kept: typeof withSerp = [];
    const gone = new Map<string, string>();
    for (const x of withSerp) {
      const host = x.n.isRoot
        ? undefined
        : kept.find((k) => {
            if (locked.has(x.n.id) && locked.has(k.n.id)) return false;
            if (locked.has(x.n.id)) return false;
            let shared = 0;
            for (const u of x.keys) if (k.keys.has(u)) shared++;
            return shared >= MIN_SHARED_URLS;
          });
      if (!host) {
        kept.push(x);
        continue;
      }
      const sharedUrls = [...x.keys].filter((u) => host.keys.has(u));
      const h = host.n;
      h.queries.push(...x.n.queries.filter((q) => !h.queries.includes(q)));
      h.sections.push(
        {
          clusterId: x.n.clusterId ?? x.n.id,
          mainQuery: x.n.mainQuery,
          qdp: "section",
          queries: x.n.queries,
          volume: x.n.volume,
          sharedUrls,
        },
        ...x.n.sections,
      );
      h.volume += x.n.volume;
      h.gscImpressions += x.n.gscImpressions;
      if (x.n.section === "core" && h.section === "outer") h.section = "core";
      if (!h.offeringId && x.n.offeringId) h.offeringId = x.n.offeringId;
      gone.set(x.n.id, h.id);
      merges.push({ kept: h.id, folded: x.n.id, sharedUrls });
    }
    if (!gone.size) continue;
    // Children of a folded page move to the page that took it in.
    const resolve = (id: string) => {
      let cur = id;
      for (let i = 0; gone.has(cur) && i < 50; i++) cur = gone.get(cur) as string;
      return cur;
    };
    e.nodes = e.nodes.filter((n) => !gone.has(n.id));
    for (const n of e.nodes) {
      if (!n.parentId) continue;
      const p = resolve(n.parentId);
      if (p === n.id) delete n.parentId;
      else n.parentId = p;
    }
  }
  return merges;
}
