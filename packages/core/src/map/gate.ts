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
  kind: "core" | "outer" | "offTopic" | "conflict";
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
  return { passed: checks.every((c) => c.status !== "fail"), checks };
}
