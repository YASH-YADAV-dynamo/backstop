import { FolderGit2 } from "lucide-react";
import Link from "next/link";
import { ShieldMark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { SITE } from "@/lib/site";

const NAV = [
  { href: "/#how", label: "How it works" },
  { href: "/#safety", label: "Safety" },
  { href: "/docs", label: "Docs" },
  { href: "/dashboard", label: "Dashboard" },
] as const;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4">
        <Link href="/" aria-label={`${SITE.name} home`} className="mr-auto flex items-center gap-2 font-semibold tracking-tight">
          <ShieldMark className="size-7 text-primary" />
          <span className="text-base">{SITE.name}</span>
          <span className="rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Beta</span>
        </Link>
        <nav className="hidden items-center gap-0.5 text-sm sm:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${
                item.href === "/docs" || item.href === "/dashboard" ? "" : "hidden md:block"
              }`}
            >
              {item.label}
            </Link>
          ))}
          <a
            href={SITE.repoUrl}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="GitHub repository"
          >
            <FolderGit2 className="size-4" aria-hidden />
            <span className="hidden lg:inline">GitHub</span>
          </a>
        </nav>
        <ThemeToggle />
        <Button asChild size="sm">
          <Link href="/app">Launch app</Link>
        </Button>
      </div>
    </header>
  );
}
