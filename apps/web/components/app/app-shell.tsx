"use client";

import { BrowserNotice } from "@/components/app/browser-notice";
import { EvmIdentityProvider } from "@/components/app/evm-identity";
import { Facts, Home, useAdvanced } from "@/components/app/home";
import { PendingBanner } from "@/components/app/pending-banner";
import { PolicyProvider, usePolicyContext } from "@/components/app/policy-context";
import { Wizard } from "@/components/app/wizard";
import { Toaster } from "@/components/ui/toaster";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { appStage } from "@/lib/app-flow";
import { useMounted } from "@/lib/use-client";

export function AppShell() {
  const mounted = useMounted();
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:py-10">
      <Toaster />
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Protect your loan</h1>
        <p className="mt-1 text-sm text-muted-foreground">Backstop repays part of your Aave loan before it can be liquidated.</p>
      </header>
      {mounted ? (
        <EvmIdentityProvider>
          <PolicyProvider>
            <Screen />
          </PolicyProvider>
        </EvmIdentityProvider>
      ) : (
        <div className="h-64 animate-pulse rounded-xl border bg-card" aria-busy="true" aria-label="Loading" />
      )}
    </div>
  );
}

/** Wizard until the vault is safe, set up and funded; then the status home. Two columns on desktop. */
function Screen() {
  const { owner, policyId, query, snap, checks, owned, verified, activated } = usePolicyContext();
  const advanced = useAdvanced();
  const stage = appStage({
    owner,
    policyId,
    readError: query.isError && !snap,
    loaded: snap !== null && checks !== null,
    owned,
    verified,
    activated,
    usdcBalance: snap?.usdcBalance ?? 0n,
    rescueCount: snap?.status.rescue_count ?? 0,
  });

  return (
    <div className="space-y-4">
      <BrowserNotice />
      <PendingBanner />
      <div className="space-y-6 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-6 lg:space-y-0">
        <div className="min-w-0">{stage === "home" ? <Home advanced={advanced} /> : <Wizard stage={stage} advanced={advanced} />}</div>
        <aside className="min-w-0 lg:sticky lg:top-24">{stage === "home" ? <Facts className="hidden lg:grid lg:grid-cols-1" /> : <HowItWorks />}</aside>
      </div>
    </div>
  );
}

function HowItWorks() {
  const { chain, snap } = usePolicyContext();
  const steps = ["Your loan's health drops below your limit.", `Backstop moves USDC from your vault to ${snap ? chain.name : "your loan's chain (Base or Arbitrum)"}.`,"It repays part of the loan, within your limits."];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">How a rescue works</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3 text-sm text-muted-foreground">
          {steps.map((s, i) => (
            <li key={s} className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium text-foreground">{i + 1}</span>
              <span className="pt-0.5">{s}</span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
