import type {
  BriefEvidence,
  BriefLink,
  BriefQuestion,
  BriefResult,
  BusinessProfile,
  ClientContext,
  FilteredQuery,
  MapNode,
  Persona,
  ReadingLevel,
  SerpSnapshot,
  SignalSet,
  SiteMaps,
  Source,
  TopicalMap,
} from "@mycel/schema";
import { stemToken } from "../cluster/cluster.ts";
import { canonical } from "../filter/rules.ts";
import { QUESTION_WORDS } from "../map/rules.ts";
import { BRIEF, FACT_LABELS } from "./rules.ts";

/**
 * What a brief is made from (ADR 0020), cut from the files the pipeline already wrote: the map
 * page, its links, the results pages of its searches, the questions in them, the competitors'
 * gap topics and the facts in the business profile. Data only: nothing here calls a model or
 * pays for anything, so the dry run can count a brief before it is written.
 */

export interface BriefData {
  /** The context with the confirmed business profile in it. */
  context: ClientContext;
  maps: SiteMaps;
  /** Results pages: research.json's, plus what the cache holds for the page's searches. */
  serps: SerpSnapshot[];
  queries?: FilteredQuery[];
  signals?: SignalSet;
}

export interface BriefSources {
  page: MapNode;
  centralEntity: string;
  offering?: { id: string; name: string };
  persona?: Pick<Persona, "id" | "name" | "who" | "needs">;
  research: { runId: string; createdAt: string };
  results: BriefResult[];
  questions: BriefQuestion[];
  evidence: BriefEvidence[];
  links: BriefLink[];
  terms: string[];
  targets: { words: number; keyword: { term: string; uses: number }; readingLevel: ReadingLevel };
}

const bare = (host: string) => host.replace(/^www\./, "");

/** A map page by its id, its planned or live URL, or its main search. */
export function findPage(
  maps: SiteMaps,
  ref: string,
): { map: TopicalMap; node: MapNode } | undefined {
  const want = ref.trim();
  const low = canonical(want);
  for (const by of [
    (n: MapNode) => n.id === want,
    (n: MapNode) => n.proposedUrl === want || n.existingPage?.url === want,
    (n: MapNode) => canonical(n.mainQuery) === low,
  ]) {
    for (const map of maps.maps) {
      const node = map.nodes.find(by);
      if (node) return { map, node };
    }
  }
  return undefined;
}

/** The first `count` pages of the first plan, in plan order. */
export function firstPlanPages(maps: SiteMaps, count: number): MapNode[] {
  return maps.maps
    .flatMap((m) => m.nodes)
    .filter((n) => n.wave === "now" && n.planStep !== undefined)
    .sort((a, b) => (a.planStep ?? 0) - (b.planStep ?? 0))
    .slice(0, count);
}

/** The searches a page answers: its own and those of the sections on it. */
export const briefSearches = (n: MapNode) => [
  ...new Set([
    n.mainQuery,
    ...n.queries,
    ...n.sections.flatMap((s) => [s.mainQuery, ...s.queries]),
  ]),
];

type Offering = BusinessProfile["offerings"][number];

/** A fact's own source: a page of the site when the profile cites one, else the profile field. */
function sourceOf(sources: Source[], ref: string, siteUrl: string): BriefEvidence["source"] {
  const page = sources.find((s) => s.from === "site" && s.ref?.startsWith("/"));
  if (page?.ref) return { kind: "url", url: new URL(page.ref, siteUrl).href };
  return { kind: "business", ref };
}

/**
 * Every fact from the business profile this page may state: the general facts and
 * differentiators, what the profile says about the page's offering, and the places served.
 * Quoted as the profile has them; numbered e1, e2, ... in that order.
 */
export function evidenceFor(context: ClientContext, offering?: Offering): BriefEvidence[] {
  const b = context.business;
  if (!b) return [];
  const labels =
    FACT_LABELS[context.market.language] ?? (FACT_LABELS.en as (typeof FACT_LABELS)[string]);
  const site = context.site.url;
  const out: Omit<BriefEvidence, "id">[] = [];
  const add = (fact: string, source: BriefEvidence["source"]) => {
    const text = fact.replace(/\s+/g, " ").trim();
    if (text && !out.some((e) => e.fact === text))
      out.push({ fact: text, source, check: { state: "unchecked" } });
  };
  for (const [i, f] of b.facts.entries()) add(f.fact, sourceOf(f.sources, `facts.${i}`, site));
  for (const [i, f] of b.differentiators.entries()) {
    add(f.fact, sourceOf(f.sources, `differentiators.${i}`, site));
  }
  if (offering) {
    const at = `offerings.${offering.id}`;
    for (const [i, p] of offering.proofPoints.entries()) {
      add(p, { kind: "business", ref: `${at}.proofPoints.${i}` });
    }
    if (offering.priceRange) {
      add(`${labels.price} ${offering.name}: ${offering.priceRange}`, {
        kind: "business",
        ref: `${at}.priceRange`,
      });
    }
    for (const [i, a] of offering.attributes.entries()) {
      add(`${offering.name}, ${a.name}: ${a.values.join(", ")}`, {
        kind: "business",
        ref: `${at}.attributes.${i}`,
      });
    }
    if (offering.subOfferings.length) {
      add(`${labels.range} ${offering.name}: ${offering.subOfferings.join(", ")}`, {
        kind: "business",
        ref: `${at}.subOfferings`,
      });
    }
  }
  if (!b.places.nationwide) {
    if (b.places.serves.length) {
      add(`${labels.serves}: ${b.places.serves.join(", ")}`, {
        kind: "business",
        ref: "places.serves",
      });
    }
    for (const [i, l] of b.places.locations.entries()) {
      add(`${labels.location}: ${l.name}, ${l.address ?? l.city}`, {
        kind: "business",
        ref: `places.locations.${i}`,
      });
    }
  }
  return out.slice(0, BRIEF.maxEvidence).map((e, i) => ({ id: `e${i + 1}`, ...e }));
}

const stems = (text: string, language: string) =>
  new Set(
    canonical(text)
      .split(" ")
      .filter((w) => w.length >= 4)
      .map((w) => stemToken(w, language)),
  );

/**
 * Questions the page could answer, as they were found: people also ask and related searches on
 * its results pages, its own searches that are questions, and the competitors' gap topics that
 * share a word with it. Main search first, no doubles.
 */
export function questionsFor(
  node: MapNode,
  serps: SerpSnapshot[],
  language: string,
  signals?: SignalSet,
): BriefQuestion[] {
  const searches = briefSearches(node);
  const byKeyword = new Map(serps.map((s) => [canonical(s.keyword), s]));
  const own = searches.map((q) => byKeyword.get(canonical(q))).filter((s) => s !== undefined);
  const out: BriefQuestion[] = [];
  const seen = new Set(searches.map(canonical));
  const add = (question: string, from: BriefQuestion["from"]) => {
    const key = canonical(question);
    if (!key || seen.has(key) || out.length >= BRIEF.maxQuestionCandidates) return;
    seen.add(key);
    out.push({ question: question.trim(), from });
  };
  for (const s of own) for (const q of s.peopleAlsoAsk) add(q, "people_also_ask");
  const words = QUESTION_WORDS[language] ?? new Set<string>();
  for (const q of searches) {
    if (out.length < BRIEF.maxQuestionCandidates && words.has(canonical(q).split(" ")[0] ?? "")) {
      out.push({ question: q, from: "search" });
    }
  }
  for (const s of own) for (const q of s.relatedSearches) add(q, "related_search");
  const mine = new Set(
    [...searches, ...(node.terms ?? [])].flatMap((q) => [...stems(q, language)]),
  );
  for (const g of signals?.competitors?.gaps ?? []) {
    if ([...stems(g.topic, language)].some((s) => mine.has(s))) add(g.topic, "gap");
  }
  return out.slice(0, BRIEF.maxQuestionCandidates);
}

/** The top results for the page's main search, without the client's own pages. */
export function resultsFor(node: MapNode, serps: SerpSnapshot[], siteUrl: string): BriefResult[] {
  const host = bare(new URL(siteUrl).hostname);
  const searches = briefSearches(node).map(canonical);
  const serp = searches
    .map((q) => serps.find((s) => canonical(s.keyword) === q))
    .find((s) => s !== undefined);
  if (!serp) return [];
  return serp.organic
    .filter((o) => !o.domain || bare(o.domain) !== host)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, BRIEF.maxResults)
    .map((o) => ({ rank: o.rank, title: o.title, url: o.url, domain: o.domain }));
}

/** The map's links from this page and to it, with the other page's own words as anchor. */
export function linksFor(map: TopicalMap, node: MapNode): BriefLink[] {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const urlOf = (n: MapNode) => n.existingPage?.url ?? n.proposedUrl;
  const nameOf = (n: MapNode) => n.name ?? n.mainQuery;
  const out: BriefLink[] = [];
  const seen = new Set<string>();
  const add = (l: BriefLink) => {
    const key = `${l.direction}:${l.nodeId}`;
    if (seen.has(key) || l.nodeId === node.id) return;
    seen.add(key);
    out.push(l);
  };
  for (const l of node.linksOut) {
    const to = byId.get(l.to);
    if (!to) continue;
    add({
      direction: "to",
      nodeId: to.id,
      url: urlOf(to),
      name: nameOf(to),
      type: l.type,
      anchor: l.anchor ?? to.mainQuery,
    });
  }
  for (const from of map.nodes) {
    const l = from.linksOut.find((x) => x.to === node.id);
    if (!l) continue;
    add({
      direction: "from",
      nodeId: from.id,
      url: urlOf(from),
      name: nameOf(from),
      type: l.type,
      anchor: l.anchor ?? node.mainQuery,
    });
  }
  return out;
}

/** Word, keyword and reading-level targets from the page's intent and sections. */
export function targetsFor(node: MapNode): BriefSources["targets"] {
  const base = BRIEF.words[node.intent.main] ?? BRIEF.words.informational ?? 1000;
  const sections = node.sections.filter((s) => s.qdp === "section").length;
  const words = Math.min(
    BRIEF.maxWords,
    Math.round((base + sections * BRIEF.wordsPerSection) / 50) * 50,
  );
  return {
    words,
    keyword: {
      term: node.mainQuery,
      uses: Math.max(BRIEF.minKeywordUses, Math.round(words / BRIEF.wordsPerKeywordUse)),
    },
    readingLevel: BRIEF.readingLevel,
  };
}

/** Everything one page's brief is made from. Throws when the page is not in the map. */
export function briefSources(data: BriefData, nodeId: string): BriefSources {
  const found = findPage(data.maps, nodeId);
  if (!found) throw new Error(`no page ${nodeId} in the map`);
  const { map, node } = found;
  const offering = data.context.business?.offerings.find((o) => o.id === node.offeringId);
  const persona = data.maps.personas?.find((p) => p.id === node.persona);
  return {
    page: node,
    centralEntity: map.header.centralEntity.name,
    ...(offering ? { offering: { id: offering.id, name: offering.name } } : {}),
    ...(persona
      ? { persona: { id: persona.id, name: persona.name, who: persona.who, needs: persona.needs } }
      : {}),
    research: { runId: map.header.runId, createdAt: map.header.createdAt },
    results: resultsFor(node, data.serps, data.context.site.url),
    questions: questionsFor(node, data.serps, data.context.market.language, data.signals),
    evidence: evidenceFor(data.context, offering),
    links: linksFor(map, node),
    terms: node.terms ?? [],
    targets: targetsFor(node),
  };
}
