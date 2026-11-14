"use client";

import { LOAN_CHAINS } from "@backstop/config/registry";
import { ChainBadge } from "@/components/chain-badge";
import { usePolicyContext } from "@/components/app/policy-context";
import { usePolicyChains } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * Switches the vault, and with it the loan chain: one vault per (owner, chain). A chain with no known
 * vault is disabled. Several vaults on one chain get a picker.
 */
export function ChainSwitcher({ className }: { className?: string }) {
  const { owner, known, policyId, choose, chain } = usePolicyContext();
  const policies = usePolicyChains(known);
  if (!owner) return null;
  const loading = policies.some((p) => p.state === "loading");
  const unsupported = policies.filter((p) => p.state === "ok" && p.chain === null).length;
  const onActive = policies.filter((p) => p.chain?.key === chain.key);

  return (
    <div className={cn("space-y-2", className)}>
      <div role="group" aria-label="Loan chain" className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
        {LOAN_CHAINS.map((c) => {
          const here = policies.filter((p) => p.chain?.key === c.key);
          const active = c.key === chain.key && policyId !== null && here.some((p) => p.id === policyId);
          const target = here.find((p) => p.id === policyId) ?? here[0];
          const missing = !target;
          const title = missing ? (loading ? `Looking for your vault on ${c.name}...` : `No vault on ${c.name} yet`) : undefined;
          return (
            <span key={c.key} title={title}>
              <button
                type="button"
                disabled={missing}
                aria-pressed={active}
                onClick={() => target && choose(target.id)}
                className={cn(
                  "inline-flex h-9 items-center rounded-md px-3 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  active ? "bg-card font-medium shadow-sm ring-1 ring-border" : "hover:bg-card/60",
                )}
              >
                <ChainBadge chain={c} className="border-transparent px-0" />
              </button>
            </span>
          );
        })}
      </div>
      {onActive.length > 1 ? (
        <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          Vaults on {chain.name}
          <select
            value={policyId ?? ""}
            onChange={(e) => choose(e.target.value)}
            className="h-8 min-w-0 max-w-full rounded-md border bg-background px-2 font-mono text-xs text-foreground"
          >
            {onActive.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {unsupported > 0 ? (
        <p className="text-xs text-warn">
          {unsupported} saved {unsupported === 1 ? "vault is" : "vaults are"} on a chain Backstop does not support, so {unsupported === 1 ? "it is" : "they are"} not listed.
        </p>
      ) : null}
    </div>
  );
}
