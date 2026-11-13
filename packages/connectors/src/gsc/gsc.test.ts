import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApiCallInput, CallRecorder } from "../recorder.ts";
import { GscClient, GscError, loadServiceAccount } from "./client.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const credentials = {
  client_email: "mycel-reader@test-project.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

function recorder() {
  const calls: ApiCallInput[] = [];
  const warnings: string[] = [];
  const rec: CallRecorder = {
    recordApiCall: (c) => {
      calls.push(c);
      return "";
    },
    log: { debug: () => {}, warn: (m) => void warnings.push(m) },
  };
  return { rec, calls, warnings };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeFetch(handler: Handler) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      return json({ access_token: "ya29.test", expires_in: 3600 });
    }
    return handler(String(url), init ?? {});
  }) as typeof fetch;
  return { impl, seen };
}

const client = (
  impl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof GscClient>[0]> = {},
) =>
  new GscClient({
    credentials,
    property: "sc-domain:example.com",
    fetchImpl: impl,
    sleep: async () => {},
    ...extra,
  });

describe("GscClient", () => {
  it("signs a valid RS256 JWT with the read-only scope", async () => {
    const { impl, seen } = fakeFetch(() => json({ siteEntry: [] }));
    await client(impl).listSites(recorder().rec);
    const body = new URLSearchParams(String(seen[0]?.init.body));
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, sig] = String(body.get("assertion")).split(".");
    const claims = JSON.parse(Buffer.from(String(c), "base64url").toString());
    expect(claims.scope).toBe("https://www.googleapis.com/auth/webmasters.readonly");
    expect(claims.iss).toBe(credentials.client_email);
    const ok = createVerify("RSA-SHA256")
      .update(`${h}.${c}`)
      .verify(publicKey, Buffer.from(String(sig), "base64url"));
    expect(ok).toBe(true);
  });

  it("reuses the token across calls", async () => {
    const { impl, seen } = fakeFetch(() => json({ siteEntry: [] }));
    const gsc = client(impl);
    const { rec } = recorder();
    await gsc.listSites(rec);
    await gsc.listSites(rec);
    expect(seen.filter((s) => s.url.includes("oauth2")).length).toBe(1);
  });

  it("pages search analytics and maps keys to dimensions", async () => {
    const bodies: Record<string, unknown>[] = [];
    const { impl, seen } = fakeFetch((_url, init) => {
      const b = JSON.parse(String(init.body)) as { startRow: number; rowLimit: number };
      bodies.push(b);
      const n = b.startRow === 0 ? b.rowLimit : 3;
      return json({
        rows: Array.from({ length: n }, (_, i) => ({
          keys: [`q${b.startRow + i}`, "/page/"],
          clicks: 1,
          impressions: 10,
          ctr: 0.1,
          position: 4.2,
        })),
      });
    });
    const { rec, calls } = recorder();
    const rows = await client(impl).searchAnalytics(
      { startDate: "2026-10-01", endDate: "2026-10-28", dimensions: ["query", "page"] },
      rec,
    );
    expect(rows.length).toBe(25_003);
    expect(rows[0]?.keys).toEqual({ query: "q0", page: "/page/" });
    expect(bodies.map((b) => b.startRow)).toEqual([0, 25_000]);
    expect(seen[1]?.url).toBe(
      "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query",
    );
    expect(calls.map((c) => c.endpoint)).toEqual([
      "oauth/token",
      "searchAnalytics/query",
      "searchAnalytics/query",
    ]);
    expect(calls.every((c) => c.status === 200 && c.costUsd === 0)).toBe(true);
  });

  it("caches pages by request hash when a cache dir is set", async () => {
    let hits = 0;
    const { impl } = fakeFetch(() => {
      hits++;
      return json({ rows: [{ keys: ["a"], clicks: 2, impressions: 3, ctr: 0.5, position: 1 }] });
    });
    const cacheDir = mkdtempSync(join(tmpdir(), "mycel-gsc-"));
    const q = {
      startDate: "2026-10-01",
      endDate: "2026-10-28",
      dimensions: ["query" as const],
      maxRows: 10,
    };
    const first = await client(impl, { cacheDir }).searchAnalytics(q, recorder().rec);
    const { rec, calls } = recorder();
    const second = await client(impl, { cacheDir }).searchAnalytics(q, rec);
    expect(second).toEqual(first);
    expect(hits).toBe(1);
    expect(calls.map((c) => c.cache)).toEqual(["hit"]);
  });

  it("retries 5xx, then gives a clear error on 403 without retrying", async () => {
    let n = 0;
    const { impl } = fakeFetch(() => {
      n++;
      return n === 1
        ? json({ error: { message: "backend" } }, 503)
        : json({ error: { message: "User does not have sufficient permission" } }, 403);
    });
    const { rec, calls, warnings } = recorder();
    const err = await client(impl)
      .searchAnalytics({ startDate: "a", endDate: "b", dimensions: ["query"] }, rec)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GscError);
    expect((err as GscError).message).toBe("HTTP 403: User does not have sufficient permission");
    expect(n).toBe(2);
    expect(warnings).toEqual(["GSC call failed, retrying"]);
    expect(calls.filter((c) => c.status !== 200).map((c) => c.status)).toEqual([503, 403]);
  });

  it("never logs the key or the access token", async () => {
    const { impl } = fakeFetch(() => json({ siteEntry: [] }));
    const { rec, calls } = recorder();
    await client(impl).listSites(rec);
    const logged = JSON.stringify(calls);
    expect(logged).not.toContain("PRIVATE KEY");
    expect(logged).not.toContain("ya29.test");
  });
});

describe("loadServiceAccount", () => {
  it("reads a key file and rejects files that are not one", () => {
    const dir = mkdtempSync(join(tmpdir(), "mycel-sa-"));
    const good = join(dir, "sa.json");
    writeFileSync(good, JSON.stringify({ type: "service_account", ...credentials }));
    expect(loadServiceAccount(good).client_email).toBe(credentials.client_email);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ installed: {} }));
    expect(() => loadServiceAccount(bad)).toThrow(/not a service account key/);
    expect(() => loadServiceAccount(join(dir, "missing.json"))).toThrow(/could not read/);
  });
});
