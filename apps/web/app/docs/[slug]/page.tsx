import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDoc, listDocs } from "@/lib/docs";

export const dynamicParams = false;

export async function generateStaticParams() {
  const docs = await listDocs();
  // Next requires at least one param for a static route; with no docs yet, "overview" 404s.
  return docs.length > 0 ? docs.map((d) => ({ slug: d.slug })) : [{ slug: "overview" }];
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = await getDoc((await params).slug);
  if (!doc) return { title: "Not found" };
  return { title: doc.title, description: doc.description || undefined, openGraph: { title: doc.title } };
}

export default async function DocPage({ params }: Props) {
  const { slug } = await params;
  const [doc, docs] = await Promise.all([getDoc(slug), listDocs()]);
  if (!doc) notFound();
  const i = docs.findIndex((d) => d.slug === slug);
  const prev = i > 0 ? docs[i - 1] : undefined;
  const next = i >= 0 && i < docs.length - 1 ? docs[i + 1] : undefined;

  return (
    <div className="flex gap-10">
      <article className="min-w-0 flex-1">
        <h1 className="t-h1">{doc.title}</h1>
        {doc.description && <p className="mt-2 text-lg text-muted-foreground">{doc.description}</p>}
        <div
          className="prose prose-neutral mt-8 max-w-none dark:prose-invert prose-a:text-primary prose-a:no-underline hover:prose-a:underline"
          dangerouslySetInnerHTML={{ __html: doc.html }}
        />
        <nav aria-label="Previous and next" className="mt-12 grid gap-3 border-t pt-6 sm:grid-cols-2">
          {prev ? (
            <Link href={`/docs/${prev.slug}`} className="rounded-xl border p-4 transition-colors hover:border-primary/50">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <ChevronLeft className="size-3" aria-hidden /> Previous
              </span>
              <span className="mt-1 block font-medium">{prev.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link href={`/docs/${next.slug}`} className="rounded-xl border p-4 text-right transition-colors hover:border-primary/50">
              <span className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                Next <ChevronRight className="size-3" aria-hidden />
              </span>
              <span className="mt-1 block font-medium">{next.title}</span>
            </Link>
          )}
        </nav>
      </article>
      {doc.toc.length > 0 && (
        <aside className="hidden w-52 shrink-0 xl:block">
          <div className="sticky top-28">
            <p className="mb-2 t-label text-muted-foreground">On this page</p>
            <ul className="flex flex-col gap-1.5 text-sm">
              {doc.toc.map((t) => (
                <li key={t.id} className={t.depth === 3 ? "pl-3" : undefined}>
                  <a href={`#${t.id}`} className="text-muted-foreground hover:text-foreground">
                    {t.text}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      )}
    </div>
  );
}
