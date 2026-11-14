import type { LoanChain } from "@backstop/config/registry";
import { ChainLogo } from "@/components/landing/chain-logo";
import { cn } from "@/lib/utils";

/** Chain name with its official logo, so the loan chain is recognisable at a glance in every card. */
export function ChainBadge({ chain, className }: { chain: Pick<LoanChain, "key" | "name">; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", className)}>
      <ChainLogo chain={chain.key} className="h-3.5" />
      {chain.name}
    </span>
  );
}
