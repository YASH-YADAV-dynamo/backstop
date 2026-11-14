import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** "Step n of 3" with one dot per step. The current dot is wide; finished ones are filled. */
export function StepProgress({ n }: { n: 1 | 2 | 3 }) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-sm font-medium">Step {n} of 3</p>
      <div className="flex gap-1.5" aria-hidden>
        {[1, 2, 3].map((i) => (
          <span key={i} className={cn("h-1.5 rounded-full", i === n ? "w-6 bg-primary" : i < n ? "w-1.5 bg-primary" : "w-1.5 bg-muted-foreground/30")} />
        ))}
      </div>
    </div>
  );
}

/** The open wizard step: a title, one sentence, and the controls. */
export function StepCard({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      {children ? <CardContent className="space-y-4">{children}</CardContent> : null}
    </Card>
  );
}

/** A finished wizard step: one line and a "Change" link that opens `children` underneath. */
export function DoneLine({ children, open, onChange, panel }: { children: ReactNode; open: boolean; onChange: () => void; panel?: ReactNode }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3 text-sm">
      <div className="flex items-center gap-3">
        <Check className="size-4 shrink-0 text-safe" aria-hidden />
        <p className="min-w-0 flex-1 break-all text-muted-foreground">{children}</p>
        <button type="button" onClick={onChange} aria-expanded={open} className="shrink-0 text-xs underline underline-offset-4 hover:text-foreground">
          Change
        </button>
      </div>
      {open && panel ? <div className="mt-3 space-y-3 border-t pt-3">{panel}</div> : null}
    </div>
  );
}
