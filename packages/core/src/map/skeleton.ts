import type { BusinessProfile } from "@mycel/schema";
import { STOPWORDS } from "../cluster/cluster.ts";
import { tokens } from "./plan.ts";
import { slugify } from "./urls.ts";

/**
 * Koray steps 5, 6 and 12 made concrete (issue #42, step 2): the map's frame comes from the
 * business, not from the clusters. Each offering is a cell; its sub-offerings and attribute
 * values are cells under it. Words people add to an offering ("kosten", "utrecht", "zakelijk")
 * are mined from the kept searches, never hardcoded. Nothing here calls a model.
 */

export interface Cell {
  /** "<offeringId>" for the offering itself, "<offeringId>/<slug>" below it. */
  id: string;
  offeringId: string;
  kind: "offering" | "sub" | "attribute";
  name: string;
  /** The attribute a value belongs to ("sector"), for attribute cells. */
  attribute?: string;
  /** Word stems a search must contain to fall in this cell. */
  key: Set<string>;
}

export interface NoGo {
  name: string;
  key: Set<string>;
}

export interface Skeleton {
  cells: Cell[];
  /** What the business doesn't do: names and aliases. */
  noGo: NoGo[];
  /** Per offering: the words searches add to it, most used first (at least MIN_MODIFIER uses). */
  modifiers: Map<string, { word: string; count: number }[]>;
  /** Per offering: every word of its name and sub-offerings, to tell a search mentions it. */
  vocab: Map<string, Set<string>>;
}

const MIN_MODIFIER = 3;
const MAX_MODIFIERS = 15;

/**
 * Two forms of one long word: the same start and short, different endings ("fysiotherapie" and
 * "fysiotherapeut", the service and the person who gives it). Stems already match plurals.
 */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 10) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 9 && a.length - i <= 3 && b.length - i <= 3;
}

export const covers = (words: Set<string>, key: Set<string>) =>
  key.size > 0 && [...key].every((k) => words.has(k) || [...words].some((w) => sameWord(w, k)));

export function buildSkeleton(
  business: BusinessProfile,
  searches: string[],
  language: string,
  /** The business's own name: left out of offering keys ("De Saak DMS" is searched as "dms"). */
  ownName = "",
): Skeleton {
  const own = tokens(ownName, language);
  const t = (s: string) => {
    const all = tokens(s, language);
    const kept = new Set([...all].filter((w) => !own.has(w)));
    return kept.size ? kept : all;
  };
  const cells: Cell[] = [];
  for (const o of business.offerings) {
    cells.push({ id: o.id, offeringId: o.id, kind: "offering", name: o.name, key: t(o.name) });
    const taken = new Set<string>([o.id]);
    const add = (cell: Omit<Cell, "id" | "offeringId">) => {
      if (!cell.key.size) return;
      let id = `${o.id}/${slugify(cell.name)}`;
      for (let i = 2; taken.has(id); i++) id = `${o.id}/${slugify(cell.name)}-${i}`;
      taken.add(id);
      cells.push({ id, offeringId: o.id, ...cell });
    };
    for (const s of o.subOfferings) add({ kind: "sub", name: s, key: t(s) });
    for (const a of o.attributes) {
      for (const v of a.values) add({ kind: "attribute", name: v, attribute: a.name, key: t(v) });
    }
  }
  const noGo = business.notOffered.flatMap((n) =>
    [n.name, ...n.aliases].map((s) => ({ name: n.name, key: t(s) })).filter((g) => g.key.size),
  );

  // Modifiers: the other words in searches that name an offering.
  const stop = STOPWORDS[language] ?? new Set<string>();
  const modifiers = new Map<string, { word: string; count: number }[]>();
  const words = searches.map(t);
  for (const o of business.offerings) {
    const own = cells.filter((c) => c.offeringId === o.id);
    const counts = new Map<string, number>();
    for (const w of words) {
      const hit = own.find((c) => covers(w, c.key));
      if (!hit) continue;
      for (const x of w) {
        if (hit.key.has(x) || stop.has(x) || x.length < 3) continue;
        counts.set(x, (counts.get(x) ?? 0) + 1);
      }
    }
    modifiers.set(
      o.id,
      [...counts]
        .filter(([, n]) => n >= MIN_MODIFIER)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_MODIFIERS)
        .map(([word, count]) => ({ word, count })),
    );
  }
  const vocab = new Map(
    business.offerings.map((o) => [
      o.id,
      new Set(
        cells
          .filter((c) => c.offeringId === o.id && c.kind !== "attribute")
          .flatMap((c) => [...c.key]),
      ),
    ]),
  );
  return { cells, noGo, modifiers, vocab };
}

/**
 * The cell a search falls in: the most specific cell whose words it contains (more words wins;
 * on a tie a sub-offering beats an attribute value, and both beat the offering itself), or none.
 * Offerings the owner marked top win a remaining tie. An attribute value ("groot", "bouw") only
 * counts when the search also mentions its offering, so a bare size or sector isn't claimed.
 */
export function cellOf(
  words: Set<string>,
  skeleton: Skeleton,
  top: Set<string> = new Set(),
): Cell | undefined {
  const rank = { sub: 2, attribute: 1, offering: 0 } as const;
  let best: Cell | undefined;
  for (const c of skeleton.cells) {
    if (!covers(words, c.key)) continue;
    if (c.kind === "attribute") {
      const vocab = skeleton.vocab.get(c.offeringId);
      if (!vocab || ![...words].some((w) => vocab.has(w))) continue;
    }
    if (
      !best ||
      c.key.size > best.key.size ||
      (c.key.size === best.key.size && rank[c.kind] > rank[best.kind]) ||
      (c.key.size === best.key.size &&
        rank[c.kind] === rank[best.kind] &&
        top.has(c.offeringId) &&
        !top.has(best.offeringId))
    ) {
      best = c;
    }
  }
  return best;
}

/** The no-go entry a search names, if any. */
export const noGoOf = (words: Set<string>, skeleton: Skeleton) =>
  skeleton.noGo.find((g) => covers(words, g.key));
