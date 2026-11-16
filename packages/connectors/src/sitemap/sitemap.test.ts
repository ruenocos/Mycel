import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { nullRecorder } from "../recorder.ts";
import { parseSitemap, robotsSitemaps, SitemapReader } from "./client.ts";

const urlset = (...urls: [string, string?][]) =>
  `<?xml version="1.0"?><urlset>${urls
    .map(
      ([loc, lastmod]) =>
        `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`,
    )
    .join("")}</urlset>`;

/** A made-up site: robots.txt points to an index with a post, a page and an author sitemap. */
const SITE: Record<string, string | Buffer> = {
  "https://planten.example/robots.txt":
    "User-agent: *\nDisallow: /wp-admin/\nSitemap: https://planten.example/sitemap_index.xml\n",
  "https://planten.example/sitemap_index.xml": `<sitemapindex><sitemap><loc>https://planten.example/post-sitemap.xml</loc></sitemap><sitemap><loc>https://planten.example/page-sitemap.xml.gz</loc></sitemap><sitemap><loc>https://planten.example/author-sitemap.xml</loc></sitemap></sitemapindex>`,
  "https://planten.example/post-sitemap.xml": urlset(
    ["https://planten.example/blog/monstera/", "2026-10-01T10:00:00+00:00"],
    ["https://planten.example/blog/pilea/"],
  ),
  "https://planten.example/page-sitemap.xml.gz": gzipSync(
    urlset(["https://planten.example/over-ons/"]),
  ),
};

function fakeFetch(site: Record<string, string | Buffer>, calls: string[]): typeof fetch {
  return async (input) => {
    const url = String(input);
    calls.push(url);
    const body = site[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    if (body === "BLOCK") return new Response("<title>Just a moment...</title>", { status: 403 });
    return new Response(typeof body === "string" ? body : new Uint8Array(body));
  };
}

describe("sitemaps (steps 8 and 11)", () => {
  it("parses an index and a URL set with dates", () => {
    expect(
      parseSitemap(SITE["https://planten.example/sitemap_index.xml"] as string).children,
    ).toHaveLength(3);
    expect(parseSitemap(SITE["https://planten.example/post-sitemap.xml"] as string).urls).toEqual([
      { loc: "https://planten.example/blog/monstera/", lastmod: "2026-10-01" },
      { loc: "https://planten.example/blog/pilea/" },
    ]);
    expect(
      robotsSitemaps("sitemap: https://a.example/s.xml\nSitemap:https://a.example/t.xml"),
    ).toEqual(["https://a.example/s.xml", "https://a.example/t.xml"]);
  });

  it("reads every content sitemap once, gzipped ones too, and skips author lists", async () => {
    const calls: string[] = [];
    const cacheDir = mkdtempSync(join(tmpdir(), "mycel-sitemap-"));
    const reader = () =>
      new SitemapReader({ cacheDir, fetchImpl: fakeFetch(SITE, calls), sleep: async () => {} });
    const site = await reader().read("planten.example", nullRecorder);
    expect(site).toMatchObject({ status: "ok", truncated: false });
    expect(site.urls.map((u) => u.loc)).toEqual([
      "https://planten.example/blog/monstera/",
      "https://planten.example/blog/pilea/",
      "https://planten.example/over-ons/",
    ]);
    expect(calls.some((c) => c.includes("author"))).toBe(false);
    // The second read comes from the cache.
    const before = calls.length;
    await reader().read("planten.example", nullRecorder);
    expect(calls).toHaveLength(before);
  });

  it("falls back to the usual paths and marks a bot check as blocked, without retrying around it", async () => {
    const calls: string[] = [];
    const plain = new SitemapReader({
      fetchImpl: fakeFetch(
        { "https://b.example/sitemap.xml": urlset(["https://b.example/a/"]) },
        calls,
      ),
      sleep: async () => {},
    });
    expect((await plain.read("b.example", nullRecorder)).urls).toHaveLength(1);

    const blocked = new SitemapReader({
      fetchImpl: fakeFetch({ "https://c.example/robots.txt": "BLOCK" }, calls),
      sleep: async () => {},
    });
    expect(await blocked.read("c.example", nullRecorder)).toMatchObject({
      status: "blocked",
      reason: "bot check (HTTP 403)",
      urls: [],
    });
    const none = new SitemapReader({ fetchImpl: fakeFetch({}, calls), sleep: async () => {} });
    expect(await none.read("d.example", nullRecorder)).toMatchObject({ status: "missing" });
  });

  it("stops at the URL cap and says so", async () => {
    const reader = new SitemapReader({
      maxUrls: 1,
      fetchImpl: fakeFetch(SITE, []),
      sleep: async () => {},
    });
    expect(await reader.read("planten.example", nullRecorder)).toMatchObject({
      truncated: true,
      urls: [{ loc: "https://planten.example/blog/monstera/" }],
    });
  });
});
