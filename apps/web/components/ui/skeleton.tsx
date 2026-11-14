import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** A pulsing placeholder block for a value that is still loading. */
export function Skeleton({ className, ...props }: ComponentProps<"span">) {
  return <span aria-hidden className={cn("inline-block h-4 w-16 animate-pulse rounded bg-muted align-middle", className)} {...props} />;
}
