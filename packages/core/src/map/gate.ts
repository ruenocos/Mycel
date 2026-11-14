import type { FilteredQuery, GateExpectations, MapNode, SiteMaps } from "@mycel/schema";
import { variantKey } from "../cluster/cluster.ts";

/**
 * The machine half of the phase 2 gate (ADR 0011) for a test client: the money queries land in
 * core, the supporting topics in outer, off-topic terms stay out, and the planted cannibalisation
 * is flagged. A query that never reached the map gets "no data", not a silent fail: that is a
 * research gap, not a map mistake.
 */

export type GateStatus = "pass" | "fail" | "no data";

export interface GateCheck {
  kind: "core" | "outer" | "offTopic" | "conflict" | "shape";
  expect: string;
  status: GateStatus;
  detail: string;
}

export interface GateResult {
  passed: boolean;
  checks: GateCheck[];
}

function where(maps: SiteMaps, query: string, language: string): MapNode | undefined {
  const key = variantKey(query, language);
  for (const map of maps.maps) {
    for (const n of map.nodes) {
      const texts = [
        n.mainQuery,
        ...n.queries,
        ...n.sections.flatMap((s) => [s.mainQuery, ...s.queries]),
      ];
      if (texts.some((t) => t === query || variantKey(t, language) === key)) return n;
    }
  }
  return undefined;
}

/** Shape thresholds: the hub count follows the business, so the gate checks ratios instead. */
export const SHAPE = { maxChildlessShare: 0.2, maxChildren: 40, minSiteHubsKept: 0.9 } as const;

export interface MapShape {
  hubs: number;
  siteHubs: number;
  siteHubsKept: number;
  childless: number;
  widest: { mainQuery: string; children: number } | null;
}

/** Tree shape of one map: hubs under the root, how many have nothing under them, the widest. */
export function mapShape(nodes: MapNode[]): MapShape {
  const kids = new Map<string, number>();
  for (const n of nodes) if (n.parentId) kids.set(n.parentId, (kids.get(n.parentId) ?? 0) + 1);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hubs = nodes.filter((n) => n.level === "seed");
  const site = nodes.filter((n) => n.hub === "site");
  const widest = nodes
    .filter((n) => n.level !== "root")
    .map((n) => ({ mainQuery: n.mainQuery, children: kids.get(n.id) ?? 0 }))
    .sort((a, b) => b.children - a.children)[0];
  return {
    hubs: hubs.length,
    siteHubs: site.length,
    siteHubsKept: site.filter(
      (n) => n.level === "seed" || byId.get(n.parentId ?? "")?.hub === "site",
    ).length,
    childless: hubs.filter((n) => !kids.get(n.id)).length,
    widest: widest ?? null,
  };
}

/** Shape checks for every map: few childless top-level pages, no giant hub, site hubs kept. */
export function shapeChecks(maps: SiteMaps): GateCheck[] {
  const checks: GateCheck[] = [];
  for (const map of maps.maps) {
    const s = mapShape(map.nodes);
    const name = map.header.centralEntity.name;
    const share = s.hubs ? s.childless / s.hubs : 0;
    checks.push({
      kind: "shape",
      expect: `${name}: at most ${SHAPE.maxChildlessShare * 100}% of top-level pages without children`,
      status: share <= SHAPE.maxChildlessShare ? "pass" : "fail",
      detail: `${s.childless} of ${s.hubs} (${Math.round(share * 100)}%)`,
    });
    checks.push({
      kind: "shape",
      expect: `${name}: no page with more than ${SHAPE.maxChildren} pages directly under it`,
      status: (s.widest?.children ?? 0) <= SHAPE.maxChildren ? "pass" : "fail",
      detail: s.widest ? `widest "${s.widest.mainQuery}" (${s.widest.children})` : "no pages",
    });
    checks.push({
      kind: "shape",
      expect: `${name}: at least ${SHAPE.minSiteHubsKept * 100}% of the site's sections stay hubs`,
      status: !s.siteHubs
        ? "no data"
        : s.siteHubsKept / s.siteHubs >= SHAPE.minSiteHubsKept
          ? "pass"
          : "fail",
      detail: s.siteHubs
        ? `${s.siteHubsKept} of ${s.siteHubs}`
        : "no service, category or location pages",
    });
  }
  return checks;
}

export function checkGate(
  maps: SiteMaps,
  expect: GateExpectations,
  opts: { language: string; queries?: FilteredQuery[] },
): GateResult {
  const { language } = opts;
  const known = new Set((opts.queries ?? []).map((q) => variantKey(q.text, language)));
  const kept = new Set(
    (opts.queries ?? []).filter((q) => q.filter?.kept).map((q) => variantKey(q.text, language)),
  );
  const checks: GateCheck[] = [];
  const missing = (q: string): GateCheck["detail"] => {
    const k = variantKey(q, language);
    if (!opts.queries) return "not in the map";
    if (!known.has(k)) return "not found in research";
    if (!kept.has(k)) return "dropped by the filter";
    return "kept, but not in a page or section (no SERP or left out)";
  };
  for (const [kind, list] of [
    ["core", expect.expectedCore],
    ["outer", expect.expectedOuter],
  ] as const) {
    for (const q of list) {
      const n = where(maps, q, language);
      if (!n) {
        const detail = missing(q);
        // Dropped by the filter or absent from research: a real miss only once research found it.
        const status: GateStatus = detail === "not found in research" ? "no data" : "fail";
        checks.push({ kind, expect: q, status, detail });
        continue;
      }
      checks.push({
        kind,
        expect: q,
        status: n.section === kind ? "pass" : "fail",
        detail: `${n.section} page "${n.mainQuery}"`,
      });
    }
  }
  for (const term of expect.offTopic) {
    const t = variantKey(term, language);
    const hits = maps.maps
      .flatMap((m) => m.nodes)
      .filter((n) => {
        const words = new Set(variantKey(n.mainQuery, language).split(" "));
        return t.split(" ").every((w) => words.has(w));
      });
    checks.push({
      kind: "offTopic",
      expect: term,
      status: hits.length ? "fail" : "pass",
      detail: hits.length ? `page "${hits[0]?.mainQuery}"` : "absent",
    });
  }
  const [a, b] = expect.plantedConflict.urls;
  const flagged = maps.maps
    .flatMap((m) => m.nodes)
    .find((n) => n.conflict?.urls.includes(a) && n.conflict.urls.includes(b));
  checks.push({
    kind: "conflict",
    expect: `${a} vs ${b}`,
    status: flagged ? "pass" : "fail",
    detail: flagged
      ? `flagged on "${flagged.mainQuery}" (${flagged.conflict?.suggestion})`
      : "not flagged",
  });
  checks.push(...shapeChecks(maps));
  return { passed: checks.every((c) => c.status !== "fail"), checks };
}
