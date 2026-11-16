import type { BusinessProfile, PageIntent, TrendLabel } from "@mycel/schema";
import { VALUE } from "./rules.ts";

/**
 * What a page is worth to the business (issue #42, step 6): offering tier x buying stage x click
 * price x opportunity, and with map signals (issue #63) a light weight for the trend and for
 * competitors' coverage. Volume is left out on purpose: it only breaks ties between equal
 * values, so a big informational search never outranks a page that sells a top offering.
 */

export type Tier = keyof typeof VALUE.tier;
export type Stage = keyof typeof VALUE.stage;

/** Buy (book, order, hire), compare (options, prices, reviews), learn (questions), find (a name). */
export function stageOf(intent: PageIntent["main"]): Stage {
  if (intent === "transactional" || intent === "local") return "buy";
  if (intent === "commercial") return "compare";
  if (intent === "navigational") return "find";
  return "learn";
}

export interface ValueInput {
  tier: Tier;
  intent: PageIntent["main"];
  cpc?: number;
  /** An existing page sits on it. */
  existing: boolean;
  /** Its searches already show the site in Google (GSC impressions). */
  seen: boolean;
  /** Where its searches are heading (signals, step 14). */
  trend?: TrendLabel;
  /** Competitors with a page on it (signals, step 11). */
  competitors?: number;
}

export function pageValue(v: ValueInput): number {
  const cpc = v.cpc === undefined ? undefined : VALUE.cpc.find((b) => (v.cpc ?? 0) >= b.min);
  const opportunity = v.existing
    ? v.seen
      ? VALUE.opportunity.seen
      : VALUE.opportunity.existing
    : VALUE.opportunity.new;
  const raw =
    VALUE.tier[v.tier] *
    VALUE.stage[stageOf(v.intent)] *
    (cpc?.weight ?? VALUE.cpcDefault) *
    opportunity *
    (v.trend ? VALUE.trend[v.trend] : 1) *
    ((v.competitors ?? 0) >= VALUE.covered.min ? VALUE.covered.weight : 1);
  return Math.round(raw * 1000) / 1000;
}

/** Higher value first; volume breaks ties. */
export const byValue = <T extends { value: number; volume: number }>(a: T, b: T) =>
  b.value - a.value || b.volume - a.volume;

/**
 * The tier of an offering. Without a business profile there are no tiers: core pages count as
 * top and the rest as normal, so the old tier split still orders the plan.
 */
export function tierOf(
  business: BusinessProfile | undefined,
  offeringId: string | undefined,
  section: "core" | "outer",
): Tier {
  if (!business) return section === "core" ? "top" : "normal";
  const o = offeringId ? business.offerings.find((x) => x.id === offeringId) : undefined;
  return o ? o.value : "none";
}

/**
 * The offerings the first plan works for: the owner's top offerings, at most three (by search
 * demand when more are marked). When none is marked top, the three with the most demand.
 */
export function topOfferings(
  business: BusinessProfile | undefined,
  demand: Map<string, number>,
): Set<string> {
  if (!business) return new Set();
  const byDemand = (ids: string[]) =>
    ids.sort((a, b) => (demand.get(b) ?? 0) - (demand.get(a) ?? 0)).slice(0, 3);
  const top = business.offerings.filter((o) => o.value === "top").map((o) => o.id);
  return new Set(byDemand(top.length ? top : business.offerings.map((o) => o.id)));
}
