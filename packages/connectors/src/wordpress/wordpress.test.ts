import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApiCallInput, CallRecorder } from "../recorder.ts";
import { commonFolder, htmlToText, kindOf, readMenu, WordPressClient } from "./client.ts";

function recorder() {
  const calls: ApiCallInput[] = [];
  const rec: CallRecorder = {
    recordApiCall: (c) => {
      calls.push(c);
      return "";
    },
    log: { debug: () => {}, warn: () => {} },
  };
  return { rec, calls };
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

const types = {
  post: { slug: "post", name: "Berichten", rest_base: "posts", rest_namespace: "wp/v2" },
  page: { slug: "page", name: "Pagina&#8217;s", rest_base: "pages", rest_namespace: "wp/v2" },
  attachment: { slug: "attachment", rest_base: "media", rest_namespace: "wp/v2" },
  wp_block: { slug: "wp_block", rest_base: "blocks", rest_namespace: "wp/v2" },
  elementor_library: {
    slug: "elementor_library",
    rest_base: "elementor_library",
    rest_namespace: "wp/v2",
  },
  dienst: { slug: "dienst", name: "Diensten", rest_base: "dienst", rest_namespace: "wp/v2" },
};

const MENU = `<ul class="menu">
  <li class="menu-item menu-item-has-children"><a href="#">Diensten</a>
    <ul class="sub-menu">
      <li class="menu-item"><a href="https://site.test/dienst/implementatie/">Implementatie</a></li>
      <li class="menu-item"><a href="/advies">Advies</a></li>
      <li class="menu-item menu-item-has-children"><a href="/extra/">Extra</a>
        <ul class="sub-menu"><li><a href="/extra/een/">Een</a></li></ul>
      </li>
    </ul>
  </li>
  <li class="menu-item"><a href="/contact/">Contact</a></li>
  <li class="menu-item menu-item-has-children"><a href="#">Elders</a>
    <ul class="sub-menu"><li><a href="https://other.test/x/">X</a></li><li><a href="mailto:a@b.c">Mail</a></li></ul>
  </li>
</ul>`;

function fakeSite(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    const u = new URL(url);
    if (u.pathname === "/") return new Response(`<html lang="nl-NL"><body>${MENU}</body></html>`);
    if (u.pathname.endsWith("/categories"))
      return json([{ id: 3, name: "Business &amp; ERP" }], { "x-wp-totalpages": "1" });
    if (u.pathname.endsWith("/types")) return json(types);
    const page = Number(u.searchParams.get("page"));
    if (u.pathname.endsWith("/pages")) {
      return json(
        [
          {
            id: 1,
            type: "page",
            slug: "home",
            link: "https://site.test/",
            title: { rendered: "Home" },
            content: {
              rendered: "<h1>Welkom &amp; meer</h1><p>Wij doen ERP.</p><script>x()</script>",
            },
            yoast_head_json: { title: "Home | Site", description: "Meta &#8211; tekst" },
          },
          {
            id: 2,
            type: "page",
            slug: "bedankt",
            link: "https://site.test/bedankt/",
            title: { rendered: "Bedankt" },
            content: { rendered: "<p>Dank</p>" },
            yoast_head_json: { robots: { index: "noindex" } },
          },
        ],
        { "x-wp-totalpages": "1" },
      );
    }
    if (u.pathname.endsWith("/posts")) {
      if (page > 2)
        return new Response('{"code":"rest_post_invalid_page_number"}', { status: 400 });
      return json(
        [
          {
            id: 10 + page,
            type: "post",
            slug: `p${page}`,
            link: `https://site.test/blog/erp/p${page}/`,
            categories: [3],
            title: { rendered: `Post ${page}` },
            content: { rendered: `<p>Tekst ${page}</p>` },
          },
        ],
        { "x-wp-totalpages": "2" },
      );
    }
    if (u.pathname.endsWith("/dienst")) {
      return json(
        [
          {
            id: 20,
            type: "dienst",
            slug: "implementatie",
            link: "https://site.test/dienst/implementatie/",
            title: { rendered: "Implementatie" },
            content: { rendered: "" },
            excerpt: { rendered: "<p>Wij implementeren.</p>" },
          },
        ],
        { "x-wp-totalpages": "1" },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe("htmlToText", () => {
  it("drops scripts and tags, decodes entities and keeps line breaks", () => {
    expect(htmlToText("<p>A &amp; B</p><script>evil()</script><p>C&#8217;s&nbsp;x</p>")).toBe(
      "A & B\nC’s x",
    );
  });
});

describe("sections helpers", () => {
  it("finds the deepest shared folder", () => {
    expect(commonFolder(["/kennisbank/ai/x/", "/kennisbank/bc/y/"])).toBe("/kennisbank/");
    expect(commonFolder(["/oplossingen/a/"])).toBe("/oplossingen/");
    expect(commonFolder(["/", "/over-ons/"])).toBe("/");
  });

  it("reads a printed-twice menu once", () => {
    const html = `<nav>${MENU}</nav><nav class="mobile">${MENU}</nav>`;
    expect(readMenu(html, "https://site.test").map((g) => g.label)).toEqual(["Diensten", "Extra"]);
  });
});

describe("kindOf", () => {
  it("uses structure only", () => {
    expect(kindOf("page", "/")).toBe("home");
    expect(kindOf("post", "/blog/x/")).toBe("blog");
    expect(kindOf("dienst", "/dienst/x/")).toBe("other");
  });
});

describe("WordPressClient", () => {
  it("reads pages, all post pages and custom types, skipping noindex and non-content types", async () => {
    const { fetchImpl, urls } = fakeSite();
    const { rec, calls } = recorder();
    const wp = new WordPressClient({ baseUrl: "https://site.test/", fetchImpl });
    const site = await wp.readSite(rec);
    expect(site.source).toBe("wordpress");
    expect(site.pages.map((p) => p.url).sort()).toEqual([
      "/",
      "/blog/erp/p1/",
      "/blog/erp/p2/",
      "/dienst/implementatie/",
    ]);
    const home = site.pages.find((p) => p.url === "/");
    expect(home).toMatchObject({
      kind: "home",
      title: "Home | Site",
      h1: "Welkom & meer",
      metaDescription: "Meta – tekst",
      text: "Welkom & meer\nWij doen ERP.",
    });
    expect(site.pages.find((p) => p.url === "/dienst/implementatie/")?.text).toBe(
      "Wij implementeren.",
    );
    // Sections (issue #51): post types with their label and folder, post categories, menu groups.
    expect(site.sections).toEqual([
      {
        key: "post",
        name: "Blog",
        folder: "/blog/erp/",
        source: "post_type",
        categories: [{ name: "Business & ERP" }],
      },
      { key: "page", name: "Pagina’s", folder: "/", source: "post_type", categories: [] },
      { key: "dienst", name: "Dienst", folder: "/dienst/", source: "post_type", categories: [] },
    ]);
    expect(site.pages.find((p) => p.url === "/blog/erp/p1/")).toMatchObject({
      section: "post",
      category: "Business & ERP",
    });
    expect(site.menu).toEqual([
      { label: "Diensten", urls: ["/dienst/implementatie/", "/advies/", "/extra/", "/extra/een/"] },
      { label: "Extra", urls: ["/extra/een/"] },
    ]);
    expect(urls.some((u) => u.includes("/media"))).toBe(false);
    expect(urls.some((u) => u.includes("/blocks") || u.includes("elementor"))).toBe(false);
    expect(calls.every((c) => c.service === "wordpress" && c.costUsd === 0)).toBe(true);
    expect(calls).toHaveLength(urls.length);
  });

  it("detects language and country from <html lang>", async () => {
    const { fetchImpl } = fakeSite();
    const wp = new WordPressClient({ baseUrl: "https://site.test", fetchImpl });
    await expect(wp.siteLanguage(recorder().rec)).resolves.toEqual({
      language: "nl",
      country: "NL",
    });
  });

  it("serves repeat reads from the cache", async () => {
    const { fetchImpl, urls } = fakeSite();
    const cacheDir = mkdtempSync(join(tmpdir(), "mycel-wp-"));
    await new WordPressClient({ baseUrl: "https://site.test", fetchImpl, cacheDir }).readSite(
      recorder().rec,
    );
    const n = urls.length;
    const { rec, calls } = recorder();
    await new WordPressClient({ baseUrl: "https://site.test", fetchImpl, cacheDir }).readSite(rec);
    expect(urls).toHaveLength(n);
    expect(calls.every((c) => c.cache === "hit")).toBe(true);
  });

  it("logs and throws on HTTP errors", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const { rec, calls } = recorder();
    await expect(
      new WordPressClient({ baseUrl: "https://site.test", fetchImpl }).readSite(rec),
    ).rejects.toThrow(/HTTP 500/);
    expect(calls[0]).toMatchObject({ status: 500, error: { name: "HttpError" } });
  });
});
