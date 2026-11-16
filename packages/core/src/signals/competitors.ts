import type {
  ClientContext,
  ClusterCoverage,
  ClusterDetail,
  CompetitorCandidate,
  CompetitorSite,
  FilteredQuery,
  GapTopic,
} from "@mycel/schema";
import { STOPWORDS } from "../cluster/cluster.ts";
import { tokens } from "../map/plan.ts";
import { cleanDomain, isPlatform, isReservedHost } from "../research/collect.ts";
import { COMPETITORS, NON_CONTENT_URL, URL_NOISE } from "./rules.ts";

/**
 * Koray steps 8 and 11 (issue #63) from competitors' sitemaps. Vastness: how many content pages
 * a competitor has. Depth: which of our page topics they have a page on. Momentum: how many
 * pages they change a month. Gaps: topics two or more competitors write about that the research
 * found no search for, as ideas for the next research round (never pages by themselves).
 */

export interface SitemapLike {
  domain: string;
  status: "ok" | "blocked" | "missing";
  reason?: string;
  urls: { loc: string; lastmod?: string }[];
  truncated: boolean;
}

/**
 * Which competitors to read: the ones the owner confirmed, then the research's candidates seen
 * most in the seed results (platforms, test domains and the site itself left out).
 */
export function pickCompetitors(
  context: ClientContext,
  candidates: CompetitorCandidate[],
  max: number = COMPETITORS.max,
): string[] {
  const own = cleanDomain(context.site.url);
  const ok = (d: string) =>
    d && d !== own && !isPlatform(d) && !isReservedHost(d) && d.includes(".");
  const confirmed = context.competitors.map(cleanDomain).filter(ok);
  const found = candidates
    .filter((c) => !c.platform && ok(cleanDomain(c.domain)))
    .filter((c) => c.inContext || c.serpAppearances >= COMPETITORS.minSerpAppearances)
    .sort(
      (a, b) =>
        b.serpAppearances - a.serpAppearances || (b.sharedKeywords ?? 0) - (a.sharedKeywords ?? 0),
    )
    .map((c) => cleanDomain(c.domain));
  return [...new Set([...confirmed, ...found])].slice(0, max);
}

const pathOf = (loc: string) => {
  try {
    return decodeURIComponent(new URL(loc).pathname);
  } catch {
    return "";
  }
};

const words = (path: string) => path.replace(/[/_\-.+]+/g, " ").trim();

/** A sitemap's content pages: no lists, accounts, legal pages or files. */
export const contentUrls = (s: SitemapLike) =>
  s.urls.filter((u) => {
    const p = pathOf(u.loc);
    return p && p !== "/" && !NON_CONTENT_URL.test(u.loc);
  });

const monthsBack = (now: Date, n: number) => {
  const out: string[] = [];
  for (let i = n; i >= 1; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
};

/** Size, folders and momentum of one competitor. */
export function siteSignals(s: SitemapLike, now: Date): { site: CompetitorSite; warning?: string } {
  const pages = contentUrls(s);
  const folders = new Map<string, number>();
  for (const u of pages) {
    const first = pathOf(u.loc).split("/").filter(Boolean);
    const f = first.length > 1 ? `/${first[0]}/` : "/";
    folders.set(f, (folders.get(f) ?? 0) + 1);
  }
  const dates = pages.map((u) => u.lastmod).filter((d): d is string => !!d);
  const days = new Map<string, number>();
  for (const d of dates) days.set(d, (days.get(d) ?? 0) + 1);
  const topDay = Math.max(0, ...days.values());
  const generated = dates.length >= 20 && topDay / dates.length > COMPETITORS.sameDayShare;
  const months = monthsBack(now, 12);
  const per = new Map(months.map((m) => [m, 0]));
  if (!generated)
    for (const d of dates)
      if (per.has(d.slice(0, 7))) per.set(d.slice(0, 7), (per.get(d.slice(0, 7)) ?? 0) + 1);
  const changes = months.map((month) => ({ month, volume: per.get(month) ?? 0 }));
  const site: CompetitorSite = {
    domain: s.domain,
    status: s.status,
    ...(s.reason ? { reason: s.reason } : {}),
    pages: pages.length,
    truncated: s.truncated,
    sections: [...folders.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, COMPETITORS.sections)
      .map(([folder, n]) => ({ folder, pages: n })),
    changesPerMonth: generated ? [] : changes,
    perMonth: generated
      ? 0
      : Math.round((changes.reduce((x, c) => x + c.volume, 0) / 12) * 10) / 10,
    dated: generated || !pages.length ? 0 : Math.round((dates.length / pages.length) * 100) / 100,
  };
  return generated
    ? {
        site,
        warning: `${s.domain}: last-modified dates look generated (one day holds most), momentum left out`,
      }
    : { site };
}

/** URL ids per word, for one competitor. */
function indexOf(urls: string[], language: string) {
  const idx = new Map<string, Set<number>>();
  urls.forEach((loc, i) => {
    for (const t of tokens(words(pathOf(loc)), language)) {
      if (!idx.has(t)) idx.set(t, new Set());
      idx.get(t)?.add(i);
    }
  });
  return idx;
}

function matchAll(idx: Map<string, Set<number>>, want: Set<string>): number[] {
  const lists = [...want].map((t) => idx.get(t)).sort((a, b) => (a?.size ?? 0) - (b?.size ?? 0));
  if (!lists.length || lists.some((l) => !l)) return [];
  const [first, ...rest] = lists as Set<number>[];
  return [...(first as Set<number>)].filter((i) => rest.every((l) => l.has(i)));
}

/**
 * Which competitors have a page on each page cluster's topic: a URL whose words hold all words
 * of the cluster's main search or of one of its biggest searches (the city left out).
 */
export function clusterCoverage(input: {
  clusters: ClusterDetail[];
  sites: SitemapLike[];
  language: string;
  city?: string;
}): ClusterCoverage[] {
  const cityWords = input.city ? tokens(input.city, input.language) : new Set<string>();
  const sites = input.sites
    .filter((s) => s.status === "ok")
    .map((s) => {
      const urls = contentUrls(s).map((u) => u.loc);
      return { domain: s.domain, urls, idx: indexOf(urls, input.language) };
    });
  const out: ClusterCoverage[] = [];
  for (const c of input.clusters.filter((x) => x.qdp === "page")) {
    const probes = [
      c.mainQuery,
      ...[...c.members]
        .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
        .slice(0, 3)
        .map((m) => m.query),
    ]
      .map((q) => new Set([...tokens(q, input.language)].filter((t) => !cityWords.has(t))))
      .filter((t) => t.size > 0);
    const competitors: string[] = [];
    const urls: string[] = [];
    for (const s of sites) {
      const hit = probes.map((p) => matchAll(s.idx, p)).find((m) => m.length);
      if (!hit) continue;
      competitors.push(s.domain);
      urls.push(...hit.slice(0, 1).map((i) => s.urls[i] as string));
    }
    if (competitors.length) out.push({ clusterId: c.id, competitors, urls });
  }
  return out;
}

/**
 * Topics competitors write about that no kept search covers: words and word pairs from their
 * URL slugs, held by two or more competitors and three or more pages, where no kept search has
 * all those words. Ideas for the next research round, not pages.
 */
export function gapTopics(input: {
  sites: SitemapLike[];
  queries: FilteredQuery[];
  language: string;
  ownDomain: string;
}): GapTopic[] {
  const stop = STOPWORDS[input.language] ?? new Set<string>();
  const kept = input.queries.filter((q) => q.filter?.kept);
  const queryIdx = new Map<string, Set<number>>();
  kept.forEach((q, i) => {
    for (const t of tokens(q.normalized, input.language)) {
      if (!queryIdx.has(t)) queryIdx.set(t, new Set());
      queryIdx.get(t)?.add(i);
    }
  });
  const searched = (gram: string[]) => matchAll(queryIdx, new Set(gram)).length > 0;
  const brand = (d: string) => new Set(d.split(".").flatMap((p) => p.split("-")));
  const own = brand(input.ownDomain);
  const grams = new Map<
    string,
    { label: string; sites: Set<string>; urls: string[]; count: number }
  >();
  for (const s of input.sites.filter((x) => x.status === "ok")) {
    const skip = brand(s.domain);
    for (const u of contentUrls(s)) {
      const slug = pathOf(u.loc).split("/").filter(Boolean).pop() ?? "";
      const raw = words(slug)
        .toLowerCase()
        .split(" ")
        .filter(
          (w) =>
            w.length >= 3 &&
            !/\d/.test(w) &&
            !stop.has(w) &&
            !URL_NOISE.has(w) &&
            !skip.has(w) &&
            !own.has(w),
        );
      const seen = new Set<string>();
      const add = (ws: string[]) => {
        const stems = ws.map((w) => [...tokens(w, input.language)][0] ?? w);
        const key = [...stems].sort().join(" ");
        if (seen.has(key)) return;
        seen.add(key);
        const g = grams.get(key) ?? {
          label: ws.join(" "),
          sites: new Set<string>(),
          urls: [],
          count: 0,
        };
        g.sites.add(s.domain);
        if (g.urls.length < 3) g.urls.push(u.loc);
        g.count++;
        grams.set(key, g);
      };
      raw.forEach((w, i) => {
        add([w]);
        if (raw[i + 1]) add([w, raw[i + 1] as string]);
      });
    }
  }
  const out: (GapTopic & { key: string })[] = [];
  for (const [key, g] of grams) {
    if (g.sites.size < COMPETITORS.gapCompetitors || g.count < COMPETITORS.gapPages) continue;
    if (searched(key.split(" "))) continue;
    out.push({
      key,
      topic: g.label,
      competitors: [...g.sites].sort(),
      pages: g.count,
      urls: g.urls,
    });
  }
  out.sort(
    (a, b) =>
      b.competitors.length - a.competitors.length ||
      b.pages - a.pages ||
      b.key.split(" ").length - a.key.split(" ").length,
  );
  // A word that only appears inside a stronger pair adds nothing.
  const picked: (GapTopic & { key: string })[] = [];
  for (const g of out) {
    const ws = g.key.split(" ");
    if (
      ws.length === 1 &&
      picked.some((p) => p.key.split(" ").includes(ws[0] as string) && p.pages >= g.pages)
    )
      continue;
    picked.push(g);
    if (picked.length >= COMPETITORS.maxGaps) break;
  }
  return picked.map(({ key: _key, ...g }) => g);
}
