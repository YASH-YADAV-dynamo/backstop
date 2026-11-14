import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const STEPS = ["Connect wallet", "Create vault", "Add USDC"] as const;

/** Numbered stepper: dots joined by a line that fills as steps finish. The current dot pulses; finished ones show a check. */
export function StepProgress({ n }: { n: 1 | 2 | 3 }) {
  return (
    <nav aria-label="Progress">
      <ol className="flex items-start">
        {STEPS.map((label, idx) => {
          const i = idx + 1;
          const done = i < n;
          const current = i === n;
          return (
            <li key={label} aria-current={current ? "step" : undefined} className={cn("flex items-start", i < 3 && "flex-1")}>
              <div className="flex w-16 shrink-0 flex-col items-center gap-1.5 sm:w-24">
                <span
                  className={cn(
                    "flex size-8 items-center justify-center rounded-full border-2 text-xs font-semibold transition-all duration-300",
                    done && "border-primary bg-primary text-primary-foreground",
                    current && "dot-halo border-primary bg-primary/15 text-primary",
                    !done && !current && "border-border text-muted-foreground",
                  )}
                >
                  {done ? <Check key="done" className="check-pop size-4" aria-hidden /> : i}
                </span>
                <span className={cn("text-center text-[0.6875rem] leading-tight transition-colors duration-300 sm:text-xs", current ? "font-medium text-foreground" : done ? "text-foreground/80" : "text-muted-foreground")}>
                  {label}
                </span>
              </div>
              {i < 3 ? (
                <span className="mt-4 h-0.5 min-w-2 flex-1 overflow-hidden rounded-full bg-border" aria-hidden>
                  <span className={cn("block h-full origin-left bg-primary transition-transform duration-500 ease-out motion-reduce:transition-none", done ? "scale-x-100" : "scale-x-0")} />
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The open wizard step: a title, one sentence, and the controls. */
export function StepCard({ title, description, art, children }: { title: string; description?: string; /** Decorative picture beside the title. */ art?: ReactNode; children?: ReactNode }) {
  return (
    <Card className="step-in overflow-hidden">
      <CardHeader className={art ? "flex flex-row items-center justify-between gap-4 border-b bg-linear-to-br from-primary/12 via-primary/4 to-transparent p-5 pb-5 sm:p-6 sm:pb-6" : undefined}>
        <div className="min-w-0 space-y-1.5">
          <CardTitle className={art ? "text-lg leading-tight sm:text-xl" : "text-base"}>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {art}
      </CardHeader>
      {children ? <CardContent className={art ? "space-y-4 p-5 pt-5 sm:p-6 sm:pt-6" : "space-y-4"}>{children}</CardContent> : null}
    </Card>
  );
}

/** A finished wizard step: one line and a "Change" link that opens `children` underneath. */
export function DoneLine({ children, open, onChange, panel }: { children: ReactNode; open: boolean; onChange: () => void; panel?: ReactNode }) {
  return (
    <div className="step-in rounded-xl border bg-card px-4 py-3 text-sm transition-colors hover:border-foreground/20">
      <div className="flex items-center gap-3">
        <Check className="check-pop size-4 shrink-0 text-safe" aria-hidden />
        <p className="min-w-0 flex-1 break-all text-muted-foreground">{children}</p>
        <button type="button" onClick={onChange} aria-expanded={open} className="shrink-0 rounded text-xs underline underline-offset-4 transition-colors hover:text-foreground active:scale-95">
          Change
        </button>
      </div>
      <div className="collapse-grid" data-open={open && panel ? "true" : "false"}>
        <div className="overflow-hidden">{open && panel ? <div className="mt-3 space-y-3 border-t pt-3">{panel}</div> : null}</div>
      </div>
    </div>
  );
}
