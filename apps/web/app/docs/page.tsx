import { BookOpen } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyNote } from "@/components/section-state";
import { listDocs } from "@/lib/docs";

export const metadata: Metadata = {
  title: "Docs",
  description: "How Backstop works: rescues, architecture, security model, policy contract, quickstart.",
};

export default async function DocsIndex() {
  const docs = await listDocs();
  return (
    <div>
      <h1 className="t-h1">Documentation</h1>
      <p className="mt-2 text-muted-foreground">How Backstop works, what it can and cannot do, and how to run it.</p>
      {docs.length === 0 ? (
        <div className="mt-8">
          <EmptyNote>The docs are being written. Check back soon, or read the README in the repository.</EmptyNote>
        </div>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2">
          {docs.map((d) => (
            <li key={d.slug}>
              <Link
                href={`/docs/${d.slug}`}
                className="flex h-full flex-col gap-2 rounded-xl border bg-card p-5 transition-colors hover:border-primary/60"
              >
                <span className="flex items-center gap-2 font-medium">
                  <BookOpen className="size-4 text-primary" aria-hidden />
                  {d.title}
                </span>
                {d.description && <span className="text-sm text-muted-foreground">{d.description}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
