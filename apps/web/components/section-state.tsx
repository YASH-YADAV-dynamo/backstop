import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

/** A friendly line, and the raw error underneath it for anyone who needs it. */
export function ErrorNote({ message, details }: { message: string; details?: string }) {
  return (
    <div role="alert" className="flex gap-3 rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium text-danger">{message}</p>
        {details ? (
          <details className="mt-2">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Technical details</summary>
            <p className="mt-2 break-words text-muted-foreground">{details}</p>
          </details>
        ) : null}
      </div>
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{children}</p>;
}
