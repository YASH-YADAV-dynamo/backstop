import type { ReactNode } from "react";
import { DocsNav } from "@/components/docs-nav";
import { listDocs } from "@/lib/docs";

export default async function DocsLayout({ children }: { children: ReactNode }) {
  const docs = await listDocs();
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 lg:flex-row lg:gap-10 lg:py-12">
      {docs.length > 0 && (
        <aside className="lg:sticky lg:top-28 lg:h-fit lg:w-52 lg:shrink-0">
          <p className="mb-2 hidden px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground lg:block">Docs</p>
          <DocsNav docs={docs} />
        </aside>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
