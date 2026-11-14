/**
 * Docs loader: markdown files in <repo>/docs/site/*.md with frontmatter
 * `title`, `description`, `order`. Rendered at build time (unified + remark-gfm + shiki).
 */
import matter from "gray-matter";
import type { Element, ElementContent, Root } from "hast";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const DOCS_DIR = join(process.cwd(), "..", "..", "docs", "site");

export interface DocMeta {
  slug: string;
  title: string;
  description: string;
  order: number;
}

export interface TocItem {
  id: string;
  text: string;
  depth: 2 | 3;
}

export interface Doc extends DocMeta {
  html: string;
  toc: TocItem[];
}

/** "02-how-a-rescue-works.md" -> "how-a-rescue-works" (the number prefix only sorts files on disk). */
const slugOf = (file: string) => file.replace(/\.md$/i, "").replace(/^\d+[-_]/, "").toLowerCase();

function metaOf(slug: string, data: Record<string, unknown>): DocMeta {
  const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : slug;
  const description = typeof data.description === "string" ? data.description.trim() : "";
  const order = typeof data.order === "number" && Number.isFinite(data.order) ? data.order : Number.MAX_SAFE_INTEGER;
  return { slug, title, description, order };
}

async function docFiles(): Promise<string[]> {
  try {
    return (await readdir(DOCS_DIR)).filter((f) => /\.md$/i.test(f)).sort();
  } catch {
    return [];
  }
}

/** All docs, ordered by `order` then title. Empty when docs/site does not exist yet. */
export async function listDocs(): Promise<DocMeta[]> {
  const files = await docFiles();
  const metas = await Promise.all(
    files.map(async (f) => metaOf(slugOf(f), matter(await readFile(join(DOCS_DIR, f), "utf8")).data)),
  );
  return metas.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

function textOf(node: ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}

function walk(node: Root | Element, fn: (el: Element) => void): void {
  for (const child of node.children) {
    if (child.type === "element") {
      fn(child);
      walk(child, fn);
    }
  }
}

/** Collects h2/h3 ids (set by rehype-slug) for the on-page table of contents. */
function rehypeToc(toc: TocItem[]) {
  return () => (tree: Root) => {
    walk(tree, (el) => {
      if ((el.tagName === "h2" || el.tagName === "h3") && typeof el.properties.id === "string") {
        toc.push({ id: el.properties.id, text: el.children.map(textOf).join(""), depth: el.tagName === "h2" ? 2 : 3 });
      }
    });
  };
}

/** The page header already shows the frontmatter title, so a leading `# Title` is dropped. */
function rehypeDropLeadingH1() {
  return (tree: Root) => {
    const first = tree.children.findIndex((c) => c.type === "element");
    const node = tree.children[first];
    if (node?.type === "element" && node.tagName === "h1") tree.children.splice(first, 1);
  };
}

/** Links like `./security.md#x` point at other docs pages; external links open in a new tab. */
function rehypeDocLinks() {
  return (tree: Root) => {
    walk(tree, (el) => {
      if (el.tagName !== "a" || typeof el.properties.href !== "string") return;
      const href = el.properties.href;
      const md = /^(?:\.\/)?([\w-]+)\.md(#.*)?$/i.exec(href);
      if (md) {
        el.properties.href = `/docs/${slugOf(`${md[1]!}.md`)}${md[2] ?? ""}`;
      } else if (/^https?:\/\//.test(href)) {
        el.properties.target = "_blank";
        el.properties.rel = ["noreferrer"];
      }
    });
  };
}

export async function getDoc(slug: string): Promise<Doc | null> {
  const file = (await docFiles()).find((f) => slugOf(f) === slug);
  if (!file) return null;
  const { content, data } = matter(await readFile(join(DOCS_DIR, file), "utf8"));
  const toc: TocItem[] = [];
  const html = String(
    await unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeDropLeadingH1)
      .use(rehypeSlug)
      .use(rehypeToc(toc))
      .use(rehypeDocLinks)
      .use(rehypePrettyCode, { theme: { light: "github-light", dark: "github-dark" }, keepBackground: false })
      .use(rehypeStringify)
      .process(content),
  );
  return { ...metaOf(slug, data), html, toc };
}
