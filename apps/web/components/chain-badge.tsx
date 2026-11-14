import type { LoanChain } from "@backstop/config/registry";
import { cn } from "@/lib/utils";

const DOT: Record<LoanChain["key"], string> = {
  base: "bg-chain-base",
  arbitrum: "bg-chain-arbitrum",
};

/** Chain name with a small colored dot, so the loan chain is recognisable at a glance in every card. */
export function ChainBadge({ chain, className }: { chain: Pick<LoanChain, "key" | "name">; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", className)}>
      <span className={cn("size-2 rounded-full", DOT[chain.key])} aria-hidden />
      {chain.name}
    </span>
  );
}
