"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { DocMeta } from "@/lib/docs";
import { cn } from "@/lib/utils";

/** Docs sidebar: a vertical list on desktop, a horizontally scrollable strip on phones. */
export function DocsNav({ docs }: { docs: DocMeta[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Docs" className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:overflow-visible lg:px-0">
      <ul className="flex gap-1 lg:flex-col">
        {docs.map((d) => {
          const active = pathname === `/docs/${d.slug}`;
          return (
            <li key={d.slug}>
              <Link
                href={`/docs/${d.slug}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors",
                  active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {d.title}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
