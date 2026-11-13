import type { FilterEvalSet, FilteredQueries } from "@mycel/schema";
import { canonical } from "./rules.ts";

/**
 * The filter's own eval (issue #17): labeled queries per test client, scored on what the filter
 * kept. "Keep" is the positive class: precision = kept queries that should be kept, recall =
 * should-keep queries that were kept.
 */

export interface FilterEvalMiss {
  query: string;
  expected: "keep" | "drop";
  got: "keep" | "drop";
  why: string;
  /** The filter's reason, when it dropped the query. */
  reason?: string;
}

export interface FilterEvalScore {
  client: string;
  cases: number;
  accuracy: number;
  precision: number;
  recall: number;
  misses: FilterEvalMiss[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function scoreFilterEval(set: FilterEvalSet, result: FilteredQueries): FilterEvalScore {
  const byKey = new Map(result.queries.map((q) => [canonical(q.text), q]));
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let right = 0;
  const misses: FilterEvalMiss[] = [];
  for (const c of set.cases) {
    const q = byKey.get(canonical(c.query));
    const got = q?.filter?.kept ? "keep" : "drop";
    if (got === c.expect) right++;
    if (got === "keep" && c.expect === "keep") tp++;
    if (got === "keep" && c.expect === "drop") fp++;
    if (got === "drop" && c.expect === "keep") fn++;
    if (got !== c.expect) {
      misses.push({
        query: c.query,
        expected: c.expect,
        got,
        why: c.why,
        ...(q?.filter?.reason ? { reason: q.filter.reason } : {}),
      });
    }
  }
  return {
    client: set.client,
    cases: set.cases.length,
    accuracy: r3(right / set.cases.length),
    precision: r3(tp + fp ? tp / (tp + fp) : 1),
    recall: r3(tp + fn ? tp / (tp + fn) : 1),
    misses,
  };
}
