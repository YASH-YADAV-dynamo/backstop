"use client";

import { BrowserNotice } from "@/components/app/browser-notice";
import { EvmIdentityProvider } from "@/components/app/evm-identity";
import { Facts, Home, useAdvanced } from "@/components/app/home";
import { PendingBanner } from "@/components/app/pending-banner";
import {
  PolicyProvider,
  usePolicyContext,
} from "@/components/app/policy-context";
import { Wizard } from "@/components/app/wizard";
import { Toaster } from "@/components/ui/toaster";
import { ChainLogo } from "@/components/landing/chain-logo";
import { appStage } from "@/lib/app-flow";
import { useMounted } from "@/lib/use-client";

export function AppShell() {
  const mounted = useMounted();
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:py-10">
      <Toaster />
      {mounted ? (
        <EvmIdentityProvider>
          <PolicyProvider>
            <Screen />
          </PolicyProvider>
        </EvmIdentityProvider>
      ) : (
        <div className="mx-auto max-w-3xl space-y-5">
          <PageTitle />
          <div
            className="h-64 animate-pulse rounded-xl border bg-card"
            aria-busy="true"
            aria-label="Loading"
          />
        </div>
      )}
    </div>
  );
}

/** Wizard until the vault is safe, set up and funded; then the status home. Two columns on desktop. */
function Screen() {
  const { owner, policyId, query, snap, checks, owned, verified, activated } =
    usePolicyContext();
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
      {stage === "home" ? (
        <>
          <PageTitle />
          <div className="space-y-6 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-6 lg:space-y-0">
            <div className="min-w-0">
              <Home advanced={advanced} />
            </div>
            <aside className="min-w-0 lg:sticky lg:top-24">
              <Facts className="hidden lg:grid lg:grid-cols-1" />
            </aside>
          </div>
        </>
      ) : (
        // Setup is one centered column: title, "how a rescue works" strip and the steps share the same edges.
        <div className="mx-auto max-w-3xl space-y-5">
          <PageTitle />
          <HowItWorks />
          <Wizard stage={stage} advanced={advanced} />
        </div>
      )}
    </div>
  );
}

function PageTitle() {
  return (
    <header>
      <h1 className="t-h2">Protect your loan</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Backstop repays part of your Aave loan before it can be liquidated.
      </p>
    </header>
  );
}

/** "How a rescue works" as one quiet row of three steps (stacks on phones). */
function HowItWorks() {
  const { chain, snap } = usePolicyContext();
  const steps = [
    { text: "Your loan's health drops below your limit.", logo: null },
    {
      text: snap
        ? `Backstop moves USDC from your vault on NEAR to ${chain.name}.`
        : "Backstop moves USDC from your vault on NEAR to your loan's chain.",
      logo: "near" as const,
    },
    {
      text: "It repays part of the loan, within your limits.",
      logo: snap ? chain.key : null,
    },
  ];
  return (
    <section
      aria-labelledby="how-rescue"
      className="rounded-xl bg-muted/40 px-4 py-3"
    >
      <h2
        id="how-rescue"
        className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        How a rescue works
      </h2>
      <ol className="mt-2 grid gap-2 text-sm text-muted-foreground sm:grid-cols-3 sm:gap-4">
        {steps.map((s, i) => (
          <li key={s.text} className="flex items-start gap-2.5">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
              {i + 1}
            </span>
            <span className="min-w-0">
              {s.logo ? (
                <ChainLogo
                  chain={s.logo}
                  className="mr-1 inline h-3.5 align-[-2px]"
                />
              ) : null}
              {s.text}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
