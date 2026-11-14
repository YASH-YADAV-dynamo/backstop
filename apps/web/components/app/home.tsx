"use client";

import { formatUsdc } from "@backstop/core";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { formatEther, type Address } from "viem";
import { HomePauseButton, LimitsBody, MoneyBody, SettingsBody } from "@/components/app/actions";
import { CloseVault } from "@/components/app/close-vault";
import { ChainSwitcher } from "@/components/app/chain-switcher";
import { EvmStep, NearStep } from "@/components/app/connect-steps";
import { GasCard } from "@/components/app/gas-card";
import { SafetyChecks, VaultDetails } from "@/components/app/manage-panel";
import { usePolicyContext } from "@/components/app/policy-context";
import { ChainBadge } from "@/components/chain-badge";
import { HfGauge } from "@/components/hf-gauge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/ui/status-pill";
import { statusPill, type PillAction } from "@/lib/app-flow";
import { DEFAULT_CHAIN, resolveChain } from "@/lib/chain";
import { useLoan, useVaultStatus } from "@/lib/queries";
import { prepareUnpause } from "@/lib/review";
import { cn } from "@/lib/utils";

/** Which Advanced items are open. Lives in the shell so a button anywhere on the page can open one. */
export function useAdvanced() {
  const [value, setValue] = useState<string[]>([]);
  const open = useCallback((item: string) => {
    setValue((v) => (v.includes(item) ? v : [...v, item]));
    requestAnimationFrame(() => document.getElementById(`adv-${item}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);
  return { value, setValue, open };
}
export type AdvancedState = ReturnType<typeof useAdvanced>;

/** The owner's tools, collapsed. Also shown under the wizard so a vault that failed its checks can still be paused and emptied. */
export function AdvancedSection({ advanced }: { advanced: AdvancedState }) {
  const { owned, snap, checks, query } = usePolicyContext();
  if (!owned || !snap || !checks) return null;
  const items: Array<[id: string, title: string, body: ReactNode]> = [
    ["money", "Add or withdraw money", <MoneyBody key="money" />],
    ["gas", "Gas money", <GasCard key="gas" />],
    ["limits", "Rescue limits", <LimitsBody key="limits" />],
    ["checks", "Safety checks", <SafetyChecks key="checks" checks={checks} />],
    ["details", "Vault details", <VaultDetails key="details" snap={snap} onRefresh={() => void query.refetch()} refreshing={query.isFetching} stale={query.isError} />],
    ["wallet", "Your wallet", <WalletBody key="wallet" />],
    ["settings", "Bot and vault settings", <SettingsBody key="settings" />],
    ["close", "Close vault & get your money back", <CloseVault key="close" />],
  ];
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Advanced</h2>
      <Accordion type="multiple" value={advanced.value} onValueChange={advanced.setValue} className="rounded-xl border bg-card px-4">
        {items.map(([id, title, body]) => (
          <AccordionItem key={id} value={id} id={`adv-${id}`} className="scroll-mt-28">
            <AccordionTrigger>{title}</AccordionTrigger>
            <AccordionContent>{body}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}

function WalletBody() {
  return (
    <div className="space-y-4">
      <NearStep />
      <EvmStep />
    </div>
  );
}

/** The vault's loan on its own chain, read through our RPC (never the user's wallet). `chain` is null for a chain Backstop does not run. */
function useVaultLoan() {
  const { snap } = usePolicyContext();
  const chain = snap ? resolveChain(snap.config.chain_id) : null;
  const loan = useLoan(chain ?? DEFAULT_CHAIN, snap ? ((snap.config.base_address as Address | null) ?? snap.derivedAddress) : null, snap && chain ? (snap.config.on_behalf_of as Address) : null);
  return { chain, loan };
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border bg-card p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/** In vault, Gas money, Rescue at. */
export function Facts({ className }: { className?: string }) {
  const { snap } = usePolicyContext();
  const { loan } = useVaultLoan();
  if (!snap) return null;
  return (
    <dl className={cn("grid grid-cols-3 gap-3 text-sm", className)}>
      <Fact label="In vault" value={`${formatUsdc(snap.usdcBalance)} USDC`} />
      <Fact label="Gas money" value={loan.data ? `${Number(formatEther(loan.data.eth)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ETH` : <Skeleton />} />
      <Fact label="Rescue at" value={(snap.limits.trigger_hf_bps / 10_000).toFixed(2)} />
    </dl>
  );
}

/** The one thing the status asks for, as a button or link. Nothing for a vault the visitor does not own. */
function PillAction({ action, advanced, onRetry }: { action: PillAction; advanced: AdvancedState; onRetry: () => void }) {
  const { owner, policyId, openReview } = usePolicyContext();
  if (!owner || !policyId) return null;
  switch (action) {
    case "resume":
      return <Button onClick={() => openReview({ kind: "unpause", prepare: () => prepareUnpause(policyId, owner) })}>Resume rescues</Button>;
    case "retry":
      return (
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
          <Link href="/docs/risks-and-limits" className="text-sm underline underline-offset-4 hover:text-foreground">
            Details
          </Link>
        </div>
      );
    case "usdc":
      return <Button onClick={() => advanced.open("money")}>Add USDC</Button>;
    case "gas":
      return <Button onClick={() => advanced.open("gas")}>Add ETH</Button>;
    case "aave":
      return (
        <Button asChild>
          <a href="https://app.aave.com" target="_blank" rel="noreferrer noopener">
            Open Aave
          </a>
        </Button>
      );
    case "none":
      return null;
  }
}

/** "Updated 40 s ago" for a reading that is not fresh. */
function agoText(updatedAt: number, now: number): string {
  const secs = Math.max(0, Math.round((now - updatedAt) / 1000));
  return secs < 90 ? `Updated ${secs} s ago` : `Updated ${Math.round(secs / 60)} min ago`;
}

/** The status screen: the status pill, the gauge as the hero, the three facts, and the one thing to do next. */
export function Home({ advanced }: { advanced: AdvancedState }) {
  const { snap, owned, paused, policyId, known } = usePolicyContext();
  const { chain, loan } = useVaultLoan();
  const botStatus = useVaultStatus(policyId);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);
  if (!snap || !policyId) return null;

  const trigger = snap.limits.trigger_hf_bps / 10_000;
  const target = snap.limits.target_hf_bps / 10_000;
  const hf = loan.data ? (loan.data.healthFactor === null ? null : Number(loan.data.healthFactor) / 1e18) : undefined;
  // A reading that failed to refresh keeps the last value on screen, dimmed and dated.
  const stale = loan.isError && loan.data !== undefined;
  // The row's age is the server's, adjusted for how long ago we asked; a failed request is "no proof of watching".
  const row = botStatus.data?.status ?? null;
  const ageMs = botStatus.data?.ageMs == null ? null : botStatus.data.ageMs + Math.max(0, now - botStatus.dataUpdatedAt);
  const pill = statusPill({
    paused,
    status: botStatus.isError ? null : row,
    statusAgeMs: botStatus.isError ? null : ageMs,
    usdcEmpty: snap.usdcBalance === 0n,
    gasEmpty: loan.data?.eth === 0n,
    hf,
    text: { trigger: trigger.toFixed(2), chain: chain?.name ?? "this chain", usdc: formatUsdc(snap.usdcBalance), maxPerRescue: formatUsdc(snap.limits.max_per_rescue) },
  });
  const loanDown = loan.isError && !loan.data;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {known.length > 1 ? <ChainSwitcher /> : chain ? <ChainBadge chain={chain} /> : <Badge variant="danger">unsupported chain</Badge>}
          {!owned ? <Badge variant="outline">View only</Badge> : null}
          <div className="ml-auto">
            <HomePauseButton />
          </div>
        </div>
        <p className="break-all text-xs text-muted-foreground">{policyId}</p>
      </div>

      {chain === null ? (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
          This vault&apos;s chain isn&apos;t supported.
        </p>
      ) : (
        <section aria-label="Loan health" className="flex flex-col items-center gap-3 rounded-2xl border bg-surface-2 px-4 py-6 shadow-[var(--shadow-card)] sm:py-8">
          {botStatus.isPending ? <Skeleton className="h-8 w-32 rounded-full" /> : <StatusPill tone={pill.tone}>{pill.label}</StatusPill>}
          {loan.data ? (
            <HfGauge key={snap.policyId} hf={hf ?? null} trigger={trigger} target={target} rescuing={pill.id === "rescuing"} staleLabel={stale ? agoText(loan.dataUpdatedAt, now) : undefined} />
          ) : loan.isPending ? (
            <Skeleton className="h-48 w-full max-w-sm rounded-xl" />
          ) : null}
          <p className="max-w-md text-balance text-center text-sm font-medium" role="status">
            {botStatus.isPending ? <Skeleton className="h-4 w-56" /> : loanDown ? "Can't read your loan right now. Retrying..." : stale ? "Can't read your loan right now. Retrying..." : pill.line}
          </p>
          <PillAction action={owned || pill.action === "retry" ? pill.action : "none"} advanced={advanced} onRetry={() => void botStatus.refetch()} />
        </section>
      )}

      <Facts className="lg:hidden" />

      {!owned ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">View only</CardTitle>
            <CardDescription>This vault belongs to {snap.config.owner}. You can look but not change anything.</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <AdvancedSection advanced={advanced} />

      <Link href={`/dashboard?policy=${encodeURIComponent(policyId)}`} className="inline-block text-sm underline underline-offset-4 hover:text-foreground">
        Rescue history
      </Link>
    </div>
  );
}
