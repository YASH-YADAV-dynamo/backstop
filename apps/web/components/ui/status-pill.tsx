import type { PillTone } from "@/lib/app-flow";
import { cn } from "@/lib/utils";

const TONE: Record<PillTone, { box: string; dot: string }> = {
  grey: { box: "border-border bg-muted text-muted-foreground", dot: "bg-muted-foreground" },
  orange: { box: "border-primary/40 bg-primary/10 text-primary", dot: "bg-primary pulse-dot" },
  red: { box: "border-danger/30 bg-danger-bg text-danger", dot: "bg-danger" },
  amber: { box: "border-warn/30 bg-warn-bg text-warn", dot: "bg-warn" },
  green: { box: "border-safe/30 bg-safe-bg text-safe", dot: "bg-safe" },
};

/** The one honest status of a vault. The dot and the word carry the meaning, never colour alone. */
export function StatusPill({ tone, children, className }: { tone: PillTone; children: string; className?: string }) {
  const t = TONE[tone];
  return (
    <span className={cn("inline-flex items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1 text-sm font-medium", t.box, className)}>
      <span className={cn("size-2 rounded-full", t.dot)} aria-hidden />
      {children}
    </span>
  );
}
