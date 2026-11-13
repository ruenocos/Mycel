import { GscClient, type GscRow, loadServiceAccount } from "@mycel/connectors";
import { CORE_VERSION, formatTimeline, RunStore } from "@mycel/core";

export interface GscCheckOptions {
  runsDir: string;
  /** Overrides GSC_PROPERTY. */
  property?: string;
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
  /** For tests. */
  client?: GscClient;
  today?: Date;
}

export interface GscCheckResult {
  runId: string;
  ok: boolean;
  lines: string[];
  timeline: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * One logged GSC session inside a run: which properties the service account can read, and
 * the top queries of the last 28 days for GSC_PROPERTY. Proves key, access and logging.
 */
export async function gscCheck(opts: GscCheckOptions): Promise<GscCheckResult> {
  const env = opts.env ?? process.env;
  const property = opts.property ?? env.GSC_PROPERTY;
  const lines: string[] = [];
  const run = RunStore.create({
    runsDir: opts.runsDir,
    client: "none",
    command: "gsc check",
    cliVersion: CORE_VERSION,
    config: { property: property ?? null },
    ...(opts.debug ? { consoleLevel: "debug" as const } : {}),
  });
  let failure: unknown;
  try {
    if (!property) throw new Error("GSC_PROPERTY is not set (e.g. sc-domain:example.com)");
    let client = opts.client;
    if (!client) {
      const path = env.GSC_CREDENTIALS_PATH;
      if (!path) throw new Error("GSC_CREDENTIALS_PATH is not set");
      client = new GscClient({ credentials: loadServiceAccount(path), property });
    }
    const gsc = client;
    lines.push(`service account  ${gsc.serviceAccountEmail}`);

    const sites = await run.step("gsc-sites", (ctx) => gsc.listSites(ctx));
    const match = sites.find((s) => s.siteUrl === property);
    lines.push(`properties       ${sites.map((s) => s.siteUrl).join(", ") || "(none)"}`);
    if (!match) {
      throw new Error(
        `the service account has no access to ${property}. Add ${gsc.serviceAccountEmail} as a user (Restricted is enough) in Search Console > Settings > Users and permissions`,
      );
    }
    lines.push(`access           ${match.permissionLevel} on ${property}`);

    // GSC data lags 2-3 days; final data only.
    const today = opts.today ?? new Date();
    const end = new Date(today.getTime() - 3 * 86_400_000);
    const start = new Date(end.getTime() - 27 * 86_400_000);
    const rows: GscRow[] = await run.step("gsc-top-queries", (ctx) =>
      gsc.searchAnalytics(
        { startDate: day(start), endDate: day(end), dimensions: ["query"], maxRows: 10 },
        ctx,
      ),
    );
    lines.push(`top queries      ${day(start)} to ${day(end)}`);
    for (const r of rows) {
      lines.push(
        `  ${String(r.clicks).padStart(5)} clicks ${String(r.impressions).padStart(7)} impr  pos ${r.position.toFixed(1).padStart(5)}  ${r.keys.query ?? ""}`,
      );
    }
    if (rows.length === 0) lines.push("  (no rows: is the property new or empty?)");
  } catch (err) {
    failure = err;
    lines.push(`error            ${(err as Error).message}`);
  }
  run.finish(failure);
  return {
    runId: run.runId,
    ok: failure === undefined,
    lines,
    timeline: formatTimeline(opts.runsDir, run.runId),
  };
}
