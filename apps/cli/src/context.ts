import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  DataforseoClient,
  FakeProvider,
  GscClient,
  LlmClient,
  type LlmProvider,
  loadServiceAccount,
  OllamaProvider,
  WordPressClient,
} from "@mycel/connectors";
import {
  buildEvidence,
  CLIENT_QUESTIONS,
  CORE_VERSION,
  contextProposeStep,
  type EvidenceExtras,
  editField,
  formatTimeline,
  markConfirmed,
  REVIEW_FIELDS,
  type ReviewField,
  RunStore,
  reviewAnswer,
  runStep,
  showField,
} from "@mycel/core";
import { ClientContext, Market, SitePages } from "@mycel/schema";

/**
 * `mycel context propose` and `mycel context confirm` (issue #15, Koray steps 1-6).
 * Thin shell: reading the site and search data, then core proposes; a person confirms.
 */

const day = (d: Date) => d.toISOString().slice(0, 10);

export function parseMarket(s: string): Market {
  const [country, language, city] = s.split(/\s*\/\s*/);
  return Market.parse({
    country: (country ?? "").toUpperCase(),
    language: (language ?? "").toLowerCase(),
    ...(city ? { city } : {}),
  });
}

function providers(env: NodeJS.ProcessEnv): LlmProvider[] {
  // The fake answers every question generically, for dry runs without a key.
  const fake = new FakeProvider([], () =>
    JSON.stringify({
      siteName: "Fake",
      sourceContext: "(fake) verdient aan de diensten op de site",
      centralEntities: [{ name: "(fake)", disambiguation: "(fake)", notThis: [] }],
      centralSearchIntent: "(fake)",
      audiences: ["(fake)"],
      offerings: ["(fake)"],
      competitors: [],
      answers: CLIENT_QUESTIONS.map((q) => ({
        id: q.id,
        answer: `(fake) ${q.id}`,
        evidence: ["page:/"],
      })),
    }),
  );
  const ollama = new OllamaProvider({
    host: env.OLLAMA_HOST ?? "https://ollama.com",
    ...(env.OLLAMA_API_KEY ? { apiKey: env.OLLAMA_API_KEY } : {}),
    timeoutMs: 300_000,
  });
  return [fake, ollama];
}

export interface ProposeOptions {
  runsDir: string;
  /** A site URL (read over the WordPress REST API) or a fixture folder with pages.json. */
  site: string;
  /** "NL / nl / Utrecht". Detected from the site's <html lang> when left out. */
  market?: string;
  out?: string;
  provider: string;
  model: string;
  /** Use GSC when GSC_PROPERTY matches the site. Default true. */
  gsc?: boolean;
  /** Use DataforSEO for ranked keywords and competitors. Default true when keys are set. */
  dataforseo?: boolean;
  budgetUsd?: number;
  cacheDir?: string;
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
  today?: Date;
}

export interface ProposeResult {
  runId: string;
  ok: boolean;
  out?: string;
  lines: string[];
  timeline: string;
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

export async function contextPropose(opts: ProposeOptions): Promise<ProposeResult> {
  const env = opts.env ?? process.env;
  const cacheDir = opts.cacheDir ?? ".cache";
  const lines: string[] = [];
  const run = RunStore.create({
    runsDir: opts.runsDir,
    client: isUrl(opts.site) ? new URL(opts.site).hostname : basename(opts.site),
    command: "context propose",
    cliVersion: CORE_VERSION,
    config: {
      site: opts.site,
      market: opts.market ?? null,
      model: opts.model,
      provider: opts.provider,
    },
    ...(opts.debug ? { consoleLevel: "debug" as const } : {}),
  });
  let out: string | undefined;
  let failure: unknown;
  try {
    const gathered = await run.step("context-sources", async (ctx) => {
      let site: SitePages;
      let siteUrl: string;
      let market = opts.market ? parseMarket(opts.market) : undefined;
      const extras: EvidenceExtras = {};
      if (isUrl(opts.site)) {
        siteUrl = new URL(opts.site).origin;
        const wp = new WordPressClient({ baseUrl: siteUrl, cacheDir: join(cacheDir, "wordpress") });
        site = await wp.readSite(ctx);
        if (!market) {
          const lang = await wp.siteLanguage(ctx);
          if (!lang?.country) {
            throw new Error(
              `can't tell the market from ${siteUrl}; pass --market "NL / nl" (country / language / city)`,
            );
          }
          market = Market.parse({ country: lang.country, language: lang.language });
          ctx.log.info("market detected from <html lang>", { market });
        }
        const host = new URL(siteUrl).hostname.replace(/^www\./, "");
        const property = env.GSC_PROPERTY;
        if (opts.gsc !== false && env.GSC_CREDENTIALS_PATH && property?.includes(host)) {
          const gsc = new GscClient({
            credentials: loadServiceAccount(env.GSC_CREDENTIALS_PATH),
            property,
          });
          const end = new Date((opts.today ?? new Date()).getTime() - 3 * 86_400_000);
          const start = new Date(end.getTime() - 89 * 86_400_000);
          const rows = await gsc.searchAnalytics(
            { startDate: day(start), endDate: day(end), dimensions: ["query"], maxRows: 100 },
            ctx,
          );
          extras.gscQueries = rows.map((r) => ({
            query: r.keys.query ?? "",
            clicks: r.clicks,
            impressions: r.impressions,
          }));
        } else if (opts.gsc !== false) {
          ctx.log.warn("GSC skipped: no credentials, or GSC_PROPERTY is not this site", {
            host,
            property: property ?? null,
          });
        }
        if (opts.dataforseo !== false && env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD) {
          const dfs = new DataforseoClient({
            login: env.DATAFORSEO_LOGIN,
            password: env.DATAFORSEO_PASSWORD,
            cacheDir: join(cacheDir, "dataforseo"),
            budgetUsd: opts.budgetUsd ?? 0.5,
          });
          const ranked = await dfs.rankedKeywords(host, market, ctx, { limit: 100 });
          extras.rankedKeywords = ranked
            .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
            .map((k) => ({
              keyword: k.keyword,
              ...(k.position !== undefined ? { position: k.position } : {}),
              ...(k.volume !== undefined ? { volume: k.volume } : {}),
              ...(k.url ? { url: k.url } : {}),
            }));
          extras.competitorDomains = (
            await dfs.competitorDomains(host, market, ctx, { limit: 15 })
          ).map((c) => ({
            domain: c.domain,
            ...(c.intersections !== undefined ? { sharedKeywords: c.intersections } : {}),
          }));
        } else if (opts.dataforseo !== false) {
          ctx.log.warn("DataforSEO skipped: DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set");
        }
      } else {
        // A fixture folder: only pages.json is read. context.json there is the answer key.
        site = SitePages.parse(JSON.parse(readFileSync(join(opts.site, "pages.json"), "utf8")));
        siteUrl = `https://${site.site.replace(/^https?:\/\//, "")}`;
        if (!market) throw new Error('a fixture has no <html lang>; pass --market "NL / nl"');
      }
      return {
        evidence: buildEvidence(site, siteUrl, extras),
        market,
        pages: site.pages.length,
        extras,
      };
    });
    const ev = gathered.evidence;
    lines.push(`site        ${ev.site.url} (${gathered.pages} pages)`);
    lines.push(
      `market      ${[gathered.market.country, gathered.market.language, gathered.market.city].filter(Boolean).join(" / ")}`,
    );
    lines.push(
      `evidence    ${ev.gscQueries.length} GSC queries, ${ev.rankedKeywords.length} ranked keywords, ${ev.competitorDomains.length} competitors`,
    );

    const llm = new LlmClient({ providers: providers(env), defaultProvider: opts.provider });
    const context = await runStep(run, contextProposeStep(llm), {
      evidence: ev,
      market: gathered.market,
      model: opts.model,
    });
    out = opts.out ?? join("clients", new URL(ev.site.url).hostname, "context.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(context, null, 2)}\n`);
    lines.push(`proposal    ${out}`);
    lines.push(`next        mycel context confirm ${out}`);
  } catch (err) {
    failure = err;
  }
  const meta = run.finish(failure);
  if (failure) lines.push(`failed      ${(failure as Error).message}`);
  return {
    runId: run.runId,
    ok: meta.status === "ok",
    ...(out ? { out } : {}),
    lines,
    timeline: formatTimeline(opts.runsDir, run.runId),
  };
}

export interface ConfirmIo {
  print(line: string): void;
  ask(prompt: string): Promise<string>;
}

const LABEL: Record<ReviewField, string> = {
  market: "Market (country / language / city)",
  sourceContext: "How the site makes money (source context)",
  centralEntities: "Central entity (name = meaning (not: look-alikes); next = ...)",
  centralSearchIntent: "Central search intent",
  audiences: "Audiences (a; b; c)",
  offerings: "Offerings (a; b; c)",
  competitors: "Competitors (domain; domain)",
};

/**
 * Walks a person through every field and answer. Enter keeps the proposal, typed text replaces
 * it, an invalid edit is explained and asked again. Saved after every answer, so quitting halfway
 * loses nothing; confirmed only at the end.
 */
export async function contextConfirm(
  file: string,
  by: string,
  io: ConfirmIo,
  now = () => new Date(),
): Promise<ClientContext> {
  if (!existsSync(file))
    throw new Error(`no context file at ${file}; run mycel context propose first`);
  let ctx = ClientContext.parse(JSON.parse(readFileSync(file, "utf8")));
  const save = () => writeFileSync(file, `${JSON.stringify(ctx, null, 2)}\n`);
  io.print(`Reviewing ${file}. Press Enter to keep a proposal, or type a replacement.`);
  for (const field of REVIEW_FIELDS) {
    for (;;) {
      io.print("");
      io.print(`${LABEL[field]}:`);
      io.print(`  ${showField(ctx, field) || "(empty)"}`);
      const typed = (await io.ask("> ")).trim();
      if (!typed) break;
      try {
        ctx = editField(ctx, field, typed);
        save();
        break;
      } catch (err) {
        io.print(`  That didn't fit: ${(err as Error).message.split("\n").slice(0, 3).join(" ")}`);
      }
    }
  }
  for (const a of ctx.answers) {
    if (a.status !== "proposed") continue;
    io.print("");
    io.print(a.question);
    io.print(`  ${a.answer}`);
    if (a.evidence.length) io.print(`  (based on: ${a.evidence.join(", ")})`);
    const typed = (await io.ask("> ")).trim();
    ctx = reviewAnswer(ctx, a.id, typed || undefined);
    save();
  }
  ctx = markConfirmed(ctx, by, now());
  save();
  io.print("");
  io.print(`Confirmed by ${by}. Saved to ${file}.`);
  return ctx;
}
