import { CONTENT_KINDS, MAX_SLUG } from "./rules.ts";

/**
 * Proposed URLs (Koray step 16). An existing page keeps its URL. A new page follows the site's own
 * folders: the folder its sibling pages already share, the site's article folder for a question
 * page, else under its hub's path, else flat.
 */

/** ASCII slug: diacritics stripped, words joined by hyphens, cut at a word, never inside one. */
export function slugify(text: string): string {
  const words = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > MAX_SLUG) break;
    out = next;
  }
  return out || words[0]?.slice(0, MAX_SLUG) || "page";
}

/** The folder part of a URL: "/a/b/" → "/a/", "/a/" → "/". */
const folderOf = (url: string) => {
  const parts = url.split("/").filter(Boolean);
  return `/${parts.slice(0, -1).join("/")}${parts.length > 1 ? "/" : ""}`;
};

/** Most common value with at least `min` hits and at least half of all; else undefined. */
function dominant(values: string[], min: number): string | undefined {
  const count = new Map<string, number>();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  const [best] = [...count.entries()].sort((a, b) => b[1] - a[1]);
  return best && best[1] >= min && best[1] * 2 >= values.length ? best[0] : undefined;
}

export interface UrlNode {
  id: string;
  isRoot: boolean;
  section: "core" | "outer";
  informational: boolean;
  mainQuery: string;
  /** The existing page that serves this node, if any. */
  existing?: string;
}

export function proposeUrls(input: {
  nodes: UrlNode[];
  /** Node id → parent id; the root has none. */
  parent: Map<string, string>;
  /** Every existing page, to follow its folders and never reuse its URL. */
  pages: { url: string; kind: string }[];
}): Map<string, string> {
  const { nodes, parent } = input;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const root = nodes.find((n) => n.isRoot);
  const used = new Set(input.pages.map((p) => p.url));
  const urlOf = new Map<string, string>();
  const articleFolder = dominant(
    input.pages
      .filter((p) => CONTENT_KINDS.has(p.kind as never))
      .map((p) => folderOf(p.url))
      .filter((f) => f !== "/"),
    3,
  );
  const children = new Map<string, UrlNode[]>();
  for (const [id, p] of parent)
    children.set(p, [...(children.get(p) ?? []), byId.get(id) as UrlNode]);
  const depth = (n: UrlNode) => {
    let d = 0;
    for (let p = parent.get(n.id); p; p = parent.get(p)) d++;
    return d;
  };
  const unique = (url: string) => {
    let u = url;
    for (let i = 2; used.has(u); i++) u = url.replace(/\/$/, `-${i}/`);
    used.add(u);
    return u;
  };
  // Parents before children, so a page can follow its hub's path.
  for (const n of [...nodes].sort((a, b) => depth(a) - depth(b))) {
    if (n.existing) {
      urlOf.set(n.id, n.existing);
      continue;
    }
    if (n.isRoot) {
      urlOf.set(n.id, "/");
      continue;
    }
    const slug = slugify(n.mainQuery);
    const p = parent.get(n.id);
    // Siblings of the same kind (articles next to articles, offers next to offers).
    const siblings = (children.get(p ?? "") ?? []).filter(
      (s) => s !== n && s.existing && s.informational === n.informational,
    );
    const siblingFolder = dominant(
      siblings.map((s) => folderOf(s.existing as string)),
      2,
    );
    const hubUrl = p && p !== root?.id ? urlOf.get(p) : undefined;
    let url: string;
    if (siblingFolder) url = `${siblingFolder}${slug}/`;
    else if (n.informational && n.section === "outer" && articleFolder)
      url = `${articleFolder}${slug}/`;
    else if (hubUrl && hubUrl !== "/" && n.section === "outer") {
      // Two folders deep at most: under a deeper hub, use its last segment as the folder.
      const parts = hubUrl.split("/").filter(Boolean);
      url = `/${parts.length <= 2 ? parts.join("/") : parts.at(-1)}/${slug}/`;
    } else url = `/${slug}/`;
    urlOf.set(n.id, unique(url));
  }
  return urlOf;
}
