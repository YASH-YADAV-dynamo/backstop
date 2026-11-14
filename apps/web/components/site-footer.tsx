import Link from "next/link";
import { ShieldMark } from "@/components/logo";
import { SITE } from "@/lib/site";

const COLS = [
  {
    title: "Product",
    links: [
      { href: "/app", label: "Protect my loan" },
      { href: "/#how", label: "How it works" },
      { href: "/#safety", label: "Safety" },
      { href: "/dashboard", label: "Dashboard" },
    ],
  },
  {
    title: "Docs",
    links: [
      { href: "/docs/quickstart", label: "Quickstart" },
      { href: "/docs/security-model", label: "Security" },
      { href: "/docs/risks-and-limits", label: "Risks and limits" },
      { href: "/docs/roadmap", label: "Roadmap" },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="relative border-t">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2 font-semibold">
            <ShieldMark className="size-6 text-primary" />
            {SITE.name}
          </div>
          <p className="mt-3 max-w-xs text-sm text-muted-foreground">
            Pulls your money from any chain to save your loan before it gets liquidated. Works with Aave on Base and Arbitrum One.
          </p>
          <p className="mt-4 text-xs text-muted-foreground">
            Beta. Smart contracts are not yet audited.{" "}
            <Link href="/docs/risks-and-limits" className="underline underline-offset-4 hover:text-foreground">Read the risks</Link>. Not financial advice.
          </p>
        </div>
        {COLS.map((c) => (
          <nav key={c.title} aria-label={c.title}>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{c.title}</p>
            <ul className="mt-3 flex flex-col gap-2 text-sm">
              {c.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-foreground/80 transition-colors hover:text-primary">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
        <nav aria-label="Project">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Project</p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            <li>
              <a href={SITE.repoUrl} className="text-foreground/80 transition-colors hover:text-primary">
                GitHub
              </a>
            </li>
            <li>
              <a href="/llms.txt" className="text-foreground/80 transition-colors hover:text-primary">
                llms.txt
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
