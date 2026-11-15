import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DataforseoClient } from "./dataforseo/client.ts";
import { GscClient } from "./gsc/client.ts";
import { USER_AGENT, withUserAgent } from "./http.ts";
import { OllamaProvider } from "./llm/ollama.ts";
import { nullRecorder } from "./recorder.ts";
import { WordPressClient } from "./wordpress/client.ts";

/**
 * A fetch that notes the User-Agent of every request and then fails: no answer is needed. Only
 * Google's token request gets one, so the real Search Console call is seen too.
 */
function spy() {
  const agents: (string | null)[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    agents.push(new Headers(init?.headers).get("user-agent"));
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }));
    }
    throw new Error("stop here");
  };
  return { agents, fetchImpl };
}

const tmp = () => mkdtempSync(join(tmpdir(), "mycel-ua-"));

describe("User-Agent", () => {
  it("is added when absent and leaves a caller's own alone", async () => {
    const seen: Record<string, string>[] = [];
    const f = withUserAgent(async (_url, init) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response("ok");
    });
    await f("https://example.com", { headers: { Accept: "text/html" } });
    await f("https://example.com", { headers: { "user-agent": "other" } });
    await f("https://example.com");
    expect(seen[0]).toEqual({ Accept: "text/html", "User-Agent": USER_AGENT });
    expect(seen[1]).toEqual({ "user-agent": "other" });
    expect(seen[2]).toEqual({ "User-Agent": USER_AGENT });
    expect(USER_AGENT).toMatch(/^Mycel\/\d+\.\d+\.\d+$/);
  });

  // One case per connector: a new connector that forgets the wrapper shows up as a missing case.
  it("is sent by every connector", async () => {
    const market = { country: "NL", language: "nl" } as const;
    const noSleep = async () => {};

    const dfs = spy();
    await new DataforseoClient({
      login: "user@example.com",
      password: "pw",
      cacheDir: tmp(),
      budgetUsd: 1,
      fetchImpl: dfs.fetchImpl,
      sleep: noSleep,
      maxRetries: 0,
    })
      .relatedKeywords("kamerplant", market, nullRecorder)
      .catch(() => {});

    const wp = spy();
    await new WordPressClient({
      baseUrl: "https://plantpost.example",
      cacheDir: tmp(),
      fetchImpl: wp.fetchImpl,
    })
      .readSite(nullRecorder)
      .catch(() => {});

    const ollama = spy();
    await new OllamaProvider({ host: "https://ollama.example", fetchImpl: ollama.fetchImpl })
      .chat({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        template: { id: "test", version: "1" },
      })
      .catch(() => {});

    const gsc = spy();
    await new GscClient({
      credentials: {
        client_email: "mycel-reader@test-project.iam.gserviceaccount.com",
        // A throwaway key made for this test: it signs the token request and guards nothing.
        private_key: generateKeyPairSync("rsa", { modulusLength: 2048 })
          .privateKey.export({ type: "pkcs8", format: "pem" })
          .toString(),
      },
      property: "sc-domain:plantpost.example",
      fetchImpl: gsc.fetchImpl,
      sleep: noSleep,
      maxRetries: 0,
    })
      .searchAnalytics(
        { startDate: "2026-10-01", endDate: "2026-10-28", dimensions: ["query"] },
        nullRecorder,
      )
      .catch(() => {});

    for (const [name, s] of Object.entries({ dfs, wp, ollama, gsc })) {
      expect(s.agents.length, name).toBeGreaterThanOrEqual(name === "gsc" ? 2 : 1);
      expect(new Set(s.agents), name).toEqual(new Set([USER_AGENT]));
    }
  });
});
