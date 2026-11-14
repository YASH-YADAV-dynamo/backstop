"use client";

import { LOAN_CHAINS } from "@backstop/config/registry";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConnectWalletButton } from "@/components/app/connect-steps";
import { useEvmIdentity } from "@/components/app/evm-identity";
import { usePolicyContext } from "@/components/app/policy-context";
import { StepCard } from "@/components/app/step-card";
import { ChainBadge } from "@/components/chain-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";
import { createBlockReason, DEFAULT_FIELDS, nearText, returnedOnClose, type CreateFields } from "@/lib/create-vault";
import { useDebt, useFactory, useNearAccount, useRefund } from "@/lib/queries";
import { prepareClaimRefund, prepareCreatePolicy } from "@/lib/review";
import { parseEvmAddress } from "@/lib/validate";
import { cn } from "@/lib/utils";

const input = "h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm";

/** The refundable deposit, in plain words. Shown on the card and again in the review. */
export function DepositNote({ amount }: { amount: bigint | null }) {
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
      <p className="text-base font-semibold">Refundable deposit: {amount === null ? <Skeleton className="h-4 w-20" /> : nearText(amount, 2)}</p>
      <p className="mt-1 text-sm text-muted-foreground">This keeps your vault on NEAR. You get it back when you close your vault.</p>
    </div>
  );
}

/** Waits for the new vault to show up in the factory's list, then selects it. */
function useSelectNewVault(before: string[] | null, done: () => void) {
  const { known, choose } = usePolicyContext();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (before === null) return;
    const fresh = known.find((id) => !before.includes(id));
    if (fresh) {
      choose(fresh);
      done();
      toast.success("Your vault is created. Next, add some USDC.");
      return;
    }
    // The create finishes a few blocks after the wallet answers: ask again every few seconds for a minute.
    let tries = 0;
    const id = setInterval(() => {
      tries++;
      void queryClient.invalidateQueries({ queryKey: ["factory-policies"] });
      if (tries >= 20) clearInterval(id);
    }, 3_000);
    return () => clearInterval(id);
  }, [before, known, choose, done, queryClient]);
}

function RefundBanner() {
  const { owner, openReview } = usePolicyContext();
  const refund = useRefund(owner);
  if (!owner || !refund.data || refund.data === 0n) return null;
  return (
    <div role="status" className="space-y-2 rounded-lg border border-warn/30 bg-warn/5 p-4 text-sm">
      <p className="font-medium">Your vault wasn&apos;t created and {nearText(refund.data, 2)} is waiting for you.</p>
      <Button size="sm" variant="outline" onClick={() => openReview({ kind: "claim_refund", prepare: () => prepareClaimRefund(owner), onSuccess: () => toast.success("Your NEAR is back in your wallet.") })}>
        Claim refund
      </Button>
    </div>
  );
}

/** "Create my Rescue vault": pick the chain, name the loan, set three limits, review once. */
export function CreateVault() {
  const { owner, known, openReview } = usePolicyContext();
  const { identity } = useEvmIdentity();
  const factory = useFactory();
  const account = useNearAccount(owner);
  const [chainKey, setChainKey] = useState<string>(LOAN_CHAINS[0]!.key);
  const [typed, setTyped] = useState<string | null>(null);
  const [fields, setFields] = useState<CreateFields>(DEFAULT_FIELDS);
  const [before, setBefore] = useState<string[] | null>(null);
  const wallet = identity.mode === "none" ? "" : identity.address;
  const loanAddress = typed ?? wallet;
  const verdict = factory.data?.verdict;
  const chains = verdict?.ok ? verdict.chains : [];
  const chain = chains.find((c) => c.key === chainKey) ?? chains[0] ?? LOAN_CHAINS[0]!;
  const parsed = useMemo(() => parseEvmAddress(loanAddress), [loanAddress]);
  const debt = useDebt(chain, parsed.ok ? parsed.value : null);
  const stop = useCallback(() => setBefore(null), []);
  useSelectNewVault(before, stop);

  const minDeposit = factory.data?.info.minDeposit ?? null;
  const reason = createBlockReason({
    factoryReady: verdict?.ok === true,
    minDeposit,
    nearBalance: account.data ? account.data.nearBalance : null,
    loanAddress,
    debtKind: debt.data?.kind ?? null,
    chainName: chain.name,
    fields,
    vaultCount: known.length,
  });

  if (factory.isError) {
    return (
      <StepCard title="Create my Rescue vault">
        <p role="alert" className="text-sm text-danger">
          We can&apos;t reach the vault service right now.
        </p>
        <Button size="sm" variant="outline" onClick={() => void factory.refetch()}>
          Try again
        </Button>
      </StepCard>
    );
  }
  if (verdict && !verdict.ok) {
    return (
      <StepCard title="Create my Rescue vault">
        <p role="alert" className="text-sm text-danger">
          {verdict.reason}
        </p>
      </StepCard>
    );
  }

  function create() {
    if (!owner || reason !== null) return;
    setBefore(known);
    openReview({
      kind: "create_policy",
      prepare: () => prepareCreatePolicy(owner, { chainKey: chain.key, loanAddress, fields }),
      onSuccess: () => toast.info("Creating your vault. This takes a few seconds."),
    });
  }

  const set = (k: keyof CreateFields) => (e: { target: { value: string } }) => setFields((f) => ({ ...f, [k]: e.target.value }));
  const label = "space-y-1 text-sm";

  return (
    <StepCard title="Create my Rescue vault" description="Your vault holds the USDC Backstop uses to repay your loan. Only you can take it out.">
      <RefundBanner />
      <div className="space-y-2">
        <p className="text-sm font-medium">Which loan?</p>
        <div role="group" aria-label="Loan chain" className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
          {(chains.length > 0 ? chains : LOAN_CHAINS).map((c) => (
            <button
              key={c.key}
              type="button"
              aria-pressed={c.key === chain.key}
              onClick={() => setChainKey(c.key)}
              className={cn("inline-flex h-9 items-center rounded-md px-3 text-sm transition-colors", c.key === chain.key ? "bg-card font-medium shadow-sm ring-1 ring-border" : "hover:bg-card/60")}
            >
              <ChainBadge chain={c} className="border-transparent px-0" />
            </button>
          ))}
        </div>
      </div>

      <label className={label}>
        <span className="font-medium">Loan address on {chain.name}</span>
        <input
          value={loanAddress}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="0x..."
          spellCheck={false}
          autoComplete="off"
          inputMode="text"
          className={cn(input, "font-mono")}
        />
        <span className="block text-xs text-muted-foreground">The address that holds your Aave loan. We only read it.</span>
      </label>
      {identity.mode === "none" ? <ConnectWalletButton variant="outline" /> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <label className={label}>
          <span className="font-medium">Rescue at health</span>
          <input inputMode="decimal" value={fields.triggerHf} onChange={set("triggerHf")} autoComplete="off" className={input} />
        </label>
        <label className={label}>
          <span className="font-medium">Most per rescue (USDC)</span>
          <input inputMode="decimal" value={fields.maxPerRescue} onChange={set("maxPerRescue")} autoComplete="off" className={input} />
        </label>
        <label className={label}>
          <span className="font-medium">Most per day (USDC)</span>
          <input inputMode="decimal" value={fields.dailyCap} onChange={set("dailyCap")} autoComplete="off" className={input} />
        </label>
      </div>

      <DepositNote amount={minDeposit} />
      {minDeposit !== null ? <p className="text-xs text-muted-foreground">About {nearText(returnedOnClose(minDeposit), 3)} comes back when you close the vault.</p> : null}

      {reason ? (
        <p role="status" className="text-sm text-muted-foreground">
          {reason}
        </p>
      ) : null}
      <Button onClick={create} disabled={reason !== null || !owner} className="w-full sm:w-auto">
        Create my Rescue vault
      </Button>
    </StepCard>
  );
}
