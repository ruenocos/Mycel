import {
  type BusinessProfile,
  ClientContext,
  type MapEval,
  MapEval as MapEvalSchema,
  type MapMetric,
  type MapNode,
  type Market,
  MIN_SHARED_URLS,
  SiteMaps,
  SitePage,
} from "@mycel/schema";
import { z } from "zod";
import { type ClusterSerp, overlapKeys, type SerpBatchPort } from "../cluster/cluster.ts";
import { tokens } from "../map/plan.ts";
import { SKIP_KINDS } from "../map/rules.ts";
import { isHome, type PageRef } from "../map/site.ts";
import { defineStep } from "../step.ts";

/**
 * The map eval (issue #42, step 0). Fixed numbers for a topical map, so every round is judged on
 * the same ruler. Deterministic: SERPs come from the cache only, nothing here calls a model.
 * Without a business profile the offer numbers fall back to the context's offering phrases.
 */

export const MAP_EVAL_VERSION = "1";
const MAX_EXAMPLES = 8;

type Node = MapNode;

interface Offer {
  id: string;
  top: boolean;
  keys: Set<string>[];
  /** The site's own page for it (a path). */
  page?: string;
}

/**
 * Every way an offering can be named: its name and sub-offerings. The business's own name is left
 * out of the keys ("De Saak DMS" is searched as "dms").
 */
function offers(ctx: ClientContext, profile: BusinessProfile | undefined): Offer[] {
  const lang = ctx.market.language;
  const own = tokens(ctx.site.name, lang);
  const t = (s: string) => {
    const all = tokens(s, lang);
    const kept = new Set([...all].filter((w) => !own.has(w)));
    return kept.size ? kept : all;
  };
  if (!profile) {
    return ctx.offerings.map((o) => ({ id: o, top: true, keys: [t(o)] }));
  }
  return profile.offerings.map((o) => ({
    id: o.id,
    top: o.value === "top",
    keys: [o.name, ...o.subOfferings].map(t).filter((k) => k.size > 0),
    ...(o.page ? { page: o.page } : {}),
  }));
}

const pathOf = (url: string) => {
  try {
    return new URL(url, "https://x.invalid").pathname;
  } catch {
    return url;
  }
};

const nodeWords = (n: Node, lang: string) =>
  tokens([n.mainQuery, n.name ?? "", ...n.queries].join(" "), lang);

const covers = (words: Set<string>, key: Set<string>) =>
  key.size > 0 && [...key].every((k) => words.has(k));

/**
 * The offering a page serves: its offeringId; else the offering whose own site page it is; else
 * the first offering whose name its searches contain.
 */
function offerOf(n: Node, all: Offer[], lang: string): Offer | undefined {
  if (n.offeringId) return all.find((o) => o.id === n.offeringId);
  const url = n.existingPage?.url;
  const byPage = url ? all.find((o) => o.page && o.page === pathOf(url)) : undefined;
  if (byPage) return byPage;
  const words = nodeWords(n, lang);
  return all.find((o) => o.keys.some((k) => covers(words, k)));
}

const metric = (value: number | null, examples: string[], extra: Partial<MapMetric> = {}) => ({
  value,
  examples: examples.slice(0, MAX_EXAMPLES),
  ...extra,
});

export interface MapEvalInput {
  maps: SiteMaps;
  context: ClientContext;
  pages: PageRef[];
  /** Cached SERPs per search; pages without one are left out of the overlap check. */
  serps: Map<string, ClusterSerp>;
  createdAt: string;
}

export function evalMap(input: MapEvalInput): MapEval {
  const { maps, context, pages, serps } = input;
  const lang = context.market.language;
  const profile = context.business;
  const all = offers(context, profile);
  const nodes = maps.maps.flatMap((m) => m.nodes);
  const real = nodes.filter((n) => n.level !== "root");
  const label = (n: Node) => n.name ?? n.mainQuery;

  // 1. Two pages for one intent: their main searches share 3+ top-10 results (ADR 0003).
  const withSerp = real
    .map((n) => ({ n, keys: serps.get(n.mainQuery) }))
    .filter((x): x is { n: Node; keys: ClusterSerp } => !!x.keys)
    .map((x) => ({ n: x.n, keys: overlapKeys(x.keys) }));
  const dupes: string[] = [];
  for (let i = 0; i < withSerp.length; i++) {
    for (let j = i + 1; j < withSerp.length; j++) {
      const a = withSerp.at(i) as (typeof withSerp)[number];
      const b = withSerp.at(j) as (typeof withSerp)[number];
      let shared = 0;
      for (const k of a.keys) if (b.keys.has(k)) shared++;
      if (shared >= MIN_SHARED_URLS) dupes.push(`${label(a.n)} | ${label(b.n)} (${shared} shared)`);
    }
  }

  // 2. Core pages that sell nothing the business offers.
  const core = real.filter((n) => n.section === "core");
  const loose = core.filter((n) => !offerOf(n, all, lang));

  // 3. Pages for something the business said it doesn't do.
  const noGo = (profile?.notOffered ?? []).flatMap((x) =>
    [x.name, ...x.aliases].map((s) => ({ name: x.name, key: tokens(s, lang) })),
  );
  const forbidden = real.filter((n) => {
    const words = nodeWords(n, lang);
    return noGo.some((g) => covers(words, g.key));
  });

  // 4. First-plan steps that neither fix a conflict nor serve a top offering.
  const now = real.filter((n) => n.wave === "now");
  const untied = now.filter((n) => n.action !== "resolve" && !offerOf(n, all, lang)?.top);

  // 5. Existing pages outside the map while a new page is planned on the same search.
  const creates = real.filter((n) => n.action === "create");
  const twins: string[] = [];
  for (const p of maps.outside) {
    const words = tokens(`${p.title} ${p.url.replace(/[/-]/g, " ")}`, lang);
    const twin = creates.find((n) => covers(words, tokens(n.mainQuery, lang)));
    if (twin) twins.push(`${p.url} ~ ${label(twin)}`);
  }

  // 6. Existing pages that have a job in the map.
  const linkable = pages.filter((p) => !isHome(p) && !SKIP_KINDS.has(p.kind));
  const used = new Set<string>();
  for (const n of nodes) {
    if (n.existingPage) used.add(n.existingPage.url);
    for (const u of n.conflict?.urls ?? []) used.add(u);
  }
  const jobless = linkable.filter((p) => !used.has(p.url));
  const share = linkable.length ? (linkable.length - jobless.length) / linkable.length : null;

  // 7. Site sections (issue #51): every page has one; a new page's URL sits in its folder.
  const sectionList = maps.siteSections;
  const unsectioned = real.filter((n) => !n.siteSection);
  const folderOf = (key: string) => sectionList?.find((s) => s.key === key)?.folder;
  const misfiled = creates.filter((n) => {
    const s = n.siteSection;
    if (!s || s.suggested) return false;
    const f = folderOf(s.key);
    return f !== undefined && !n.proposedUrl.startsWith(f);
  });
  const noSections = { note: "map made before site sections" };

  const count = (xs: Node[], key: (n: Node) => string | undefined) => {
    const out: Record<string, number> = {};
    for (const n of xs) {
      const k = key(n);
      if (k) out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };

  return MapEvalSchema.parse({
    site: maps.site,
    createdAt: input.createdAt,
    withProfile: !!profile,
    counts: {
      pages: real.length,
      core: core.length,
      outer: real.length - core.length,
      actions: count(real, (n) => n.action),
      now: count(now, (n) => n.action),
      leftOut: maps.maps.reduce((s, m) => s + m.leftOut.length, 0),
      outside: maps.outside.length,
    },
    metrics: {
      duplicateIntentPairs: metric(withSerp.length ? dupes.length : null, dupes, {
        of: withSerp.length,
        note: `${withSerp.length} of ${real.length} pages have a cached SERP`,
      }),
      coreWithoutOffering: metric(loose.length, loose.map(label), { of: core.length }),
      notOfferedPages: metric(
        profile ? forbidden.length : null,
        forbidden.map(label),
        profile ? {} : { note: "needs a business profile with what the business doesn't offer" },
      ),
      nowNotTied: metric(untied.length, untied.map(label), {
        of: now.length,
        ...(profile ? {} : { note: "without a profile every offering counts as top" }),
      }),
      outsideWithTwin: metric(twins.length, twins, { of: maps.outside.length }),
      existingWithJob: metric(
        share === null ? null : Math.round(share * 1000) / 1000,
        jobless.map((p) => p.url),
        { of: linkable.length },
      ),
      newPages: metric(creates.length, []),
      claimFailures: metric(null, [], { note: "measured from step 7 (fact check)" }),
      pagesWithoutSection: metric(
        sectionList ? unsectioned.length : null,
        unsectioned.map(label),
        sectionList ? { of: real.length } : noSections,
      ),
      newOutsideSectionFolder: metric(
        sectionList ? misfiled.length : null,
        misfiled.map((n) => `${n.proposedUrl} (${n.siteSection?.name})`),
        sectionList ? { of: creates.length } : noSections,
      ),
    },
  });
}

export const MapEvalInputSchema = z.object({
  maps: SiteMaps,
  context: ClientContext,
  pages: z.array(SitePage.pick({ url: true, kind: true, title: true, h1: true })).default([]),
  /** Fetch cached SERPs for the overlap check. Off: that number is left empty. */
  serps: z.boolean().default(true),
});

/** The eval as a step: SERPs from the cache only (paid calls must be off in the port). */
export function mapEvalStep(port?: SerpBatchPort) {
  return defineStep({
    name: "map-eval",
    version: MAP_EVAL_VERSION,
    input: MapEvalInputSchema,
    output: MapEvalSchema,
    async run(input, ctx) {
      const queries = input.maps.maps.flatMap((m) =>
        m.nodes.filter((n) => n.level !== "root").map((n) => n.mainQuery),
      );
      let serps = new Map<string, ClusterSerp>();
      if (port && input.serps) {
        const res = await port.serpOrganicBatch(queries, input.context.market as Market, ctx);
        serps = res.serps;
        if (res.blocked.length) {
          ctx.log.info("map eval: pages without a cached SERP", { count: res.blocked.length });
        }
        for (const f of res.failed) ctx.log.warn("map eval: SERP failed", f);
      }
      return evalMap({
        maps: input.maps,
        context: input.context,
        pages: input.pages,
        serps,
        createdAt: new Date().toISOString(),
      });
    },
  });
}
