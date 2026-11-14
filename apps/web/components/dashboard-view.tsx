"use client";

import { NEAR } from "@backstop/config/registry";
import { ExternalLink, Info, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChainBadge } from "@/components/chain-badge";
import { Countdown } from "@/components/countdown";
import { HfGauge } from "@/components/hf-gauge";
import { RescueHistory } from "@/components/rescue-table";
import { ErrorNote } from "@/components/section-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { VaultPrompt } from "@/components/vault-prompt";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChainView, DashboardSnapshot, PolicyView, PositionView, Section } from "@/lib/dashboard-types";
import { formatDuration, formatUtc, shortAddress } from "@/lib/format";

const REFRESH_MS = 30_000;

function SectionBody<T>({ section, children }: { section: Section<T>; children: (data: T) => ReactNode }) {
  if (section.state !== "ok") return <ErrorNote message="We couldn't load this right now." details={section.message} />;
  return <>{children(section.data)}</>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        {hint && (
          <Tooltip>
            <TooltipTrigger aria-label={`About ${label}`}>
              <Info className="size-3" aria-hidden />
            </TooltipTrigger>
            <TooltipContent>{hint}</TooltipContent>
          </Tooltip>
        )}
      </dt>
      <dd className="mt-1 truncate text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right tabular-nums">{children}</dd>
    </div>
  );
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline">
      {children}
      <ExternalLink className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

/** What the cards call the chain before a policy has been read. */
const chainText = (chain: ChainView | null) => chain?.name ?? "the loan chain";

function HealthCard({ position, policy, chain }: { position: Section<PositionView>; policy: Section<PolicyView>; chain: ChainView | null }) {
  const limits = policy.state === "ok" ? policy.data.limits : null;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Health factor</CardTitle>
          {chain ? <ChainBadge chain={chain} /> : null}
        </div>
        <CardDescription>Below 1.00 the loan can be liquidated.</CardDescription>
      </CardHeader>
      <CardContent className="flex justify-center">
        <SectionBody section={position}>
          {(p) => (
            // Keyed by the policy so switching chain animates from empty, not from the other chain's value.
            <HfGauge key={policy.state === "ok" ? policy.data.contractId : "none"} hf={p.healthFactor} trigger={limits?.triggerHf ?? null} target={limits?.targetHf ?? null} />
          )}
        </SectionBody>
      </CardContent>
    </Card>
  );
}

function PositionCard({ position, chain }: { position: Section<PositionView>; chain: ChainView | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Position</CardTitle>
        <CardDescription>Aave v3 on {chainText(chain)}.</CardDescription>
      </CardHeader>
      <CardContent>
        <SectionBody section={position}>
          {(p) => (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-5">
              <Stat label="Collateral" value={`$${p.collateralUsd}`} />
              <Stat label="Debt" value={`$${p.debtUsd}`} />
              <Stat label="Available to borrow" value={`$${p.availableBorrowUsd}`} />
              <Stat
                label="Liquidation threshold"
                value={`${p.liquidationThresholdPct}%`}
                hint="Weighted share of collateral value that counts toward the health factor."
              />
              <Stat label="USDC in rescue wallet" value={p.usdcBalance ?? "not set up"} />
              <Stat label="Gas money (ETH)" value={p.ethBalance ?? "not set up"} hint={`Pays ${chainText(chain)} gas for the repay transaction.`} />
            </dl>
          )}
        </SectionBody>
      </CardContent>
    </Card>
  );
}

function LimitsCard({ policy }: { policy: Section<PolicyView> }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Limits</CardTitle>
          {policy.state === "ok" &&
            (policy.data.limits.paused ? <Badge variant="danger">Paused</Badge> : <Badge variant="safe">Active</Badge>)}
        </div>
        <CardDescription>Backstop can never go past these.</CardDescription>
      </CardHeader>
      <CardContent>
        <SectionBody section={policy}>
          {({ limits, status }) => (
            <>
              <dl className="divide-y">
                <Row label="Rescue at health">{limits.triggerHf.toFixed(2)}</Row>
                <Row label="Repay until health">{limits.targetHf.toFixed(2)}</Row>
                <Row label="Max per rescue">{limits.maxPerRescue} USDC</Row>
                <Row label="Daily cap (UTC day)">{limits.dailyCap} USDC</Row>
              </dl>
              <div className="py-3">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span className="tabular-nums">Spent today {status.spentToday} USDC</span>
                  <span className="tabular-nums">{status.remainingToday} left</span>
                </div>
                <div
                  className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label="Daily cap used"
                  aria-valuenow={status.spentPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className={status.spentPct >= 100 ? "h-full bg-danger" : "h-full bg-primary"}
                    style={{ width: `${status.spentPct}%` }}
                  />
                </div>
              </div>
              <dl className="divide-y border-t">
                <Row label="Cooldown">
                  {formatDuration(limits.cooldownSecs)}
                  {status.cooldownEndsAt > 0 && (
                    <>
                      {" · "}
                      <Countdown endsAt={status.cooldownEndsAt} />
                    </>
                  )}
                </Row>
                <Row label="Rescues so far">{status.rescueCount}</Row>
                <Row label="Last rescue">
                  {status.lastRescueAt > 0 ? formatUtc(new Date(status.lastRescueAt * 1000).toISOString()) : "never"}
                </Row>
                <Row label="Gas fee cap">{limits.maxFeePerGasGwei} gwei</Row>
                <Row label="Gas limit cap">{limits.maxGasLimit}</Row>
              </dl>
            </>
          )}
        </SectionBody>
      </CardContent>
    </Card>
  );
}

function AddressesCard({ policy }: { policy: Section<PolicyView> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Vault details</CardTitle>
        <CardDescription>Check every address on the explorer.</CardDescription>
      </CardHeader>
      <CardContent>
        <SectionBody section={policy}>
          {(p) => (
            <dl className="divide-y">
              <Row label="Vault (NEAR)">
                <ExtLink href={p.contractUrl}>{shortAddress(p.contractId)}</ExtLink>
              </Row>
              <Row label="Owner (NEAR)">
                <ExtLink href={`${NEAR.explorer}/address/${p.owner}`}>{shortAddress(p.owner)}</ExtLink>
              </Row>
              <Row label={`Loan address (${p.chain.name})`}>
                <ExtLink href={p.borrowerUrl}>{shortAddress(p.borrower)}</ExtLink>
              </Row>
              <Row label={`Rescue wallet (${p.chain.name})`}>
                {p.derivedAddress && p.derivedAddressUrl ? (
                  <ExtLink href={p.derivedAddressUrl}>{shortAddress(p.derivedAddress)}</ExtLink>
                ) : (
                  <Badge variant="warn">not set up</Badge>
                )}
              </Row>
              <Row label="USDC in vault">{p.usdcInPolicy}</Row>
              <Row label="NEAR in vault">{p.nearInPolicy}</Row>
              <Row label="Rescue bot (NEAR)">
                <ExtLink href={p.agentUrl}>{shortAddress(p.agent)}</ExtLink>
              </Row>
              <Row label="Signer (MPC)">
                <span className="font-mono text-xs">{p.mpcContract}</span>
              </Row>
              <Row label="Derivation path">
                <span className="font-mono text-xs">{p.derivationPath}</span>
              </Row>
              <Row label="Service fee">
                {p.feeBps === 0 ? "none" : `${(p.feeBps / 100).toFixed(2)}% of each bridged amount, to ${p.feeAccount}`}
              </Row>
              {p.checks.map((c) => (
                <Row key={c.id} label={c.label}>
                  <span title={c.detail}>
                    <Badge variant={c.state === "pass" ? "safe" : c.state === "fail" ? "danger" : "warn"}>
                      {c.state === "pass" ? "passed" : c.state === "fail" ? "failed" : "not checked"}
                    </Badge>
                  </span>
                </Row>
              ))}
              <Row label="Last bridge">
                {p.bridge.last ? `${p.bridge.last.amountIn} USDC (id ${p.bridge.last.bridgeId})` : "none"}
              </Row>
            </dl>
          )}
        </SectionBody>
      </CardContent>
    </Card>
  );
}

/** The dashboard body. Starts from the server-rendered snapshot and refreshes from /api/dashboard. */
export function DashboardView({ initial, policy }: { initial: DashboardSnapshot; policy?: string }) {
  const [snap, setSnap] = useState(initial);
  const snapRef = useRef(snap);
  const [loading, setLoading] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(policy ? `/api/dashboard?policy=${encodeURIComponent(policy)}` : "/api/dashboard", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as DashboardSnapshot;
      snapRef.current = next;
      setSnap(next);
      setRefreshError(null);
    } catch (err) {
      setRefreshError(`Refresh failed (${err instanceof Error ? err.message : String(err)}); retrying. Showing the data fetched at ${formatUtc(snapRef.current.fetchedAt)}.`);
    } finally {
      setLoading(false);
    }
  }, [policy]);

  useEffect(() => {
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const chain = snap.policy.state === "ok" ? snap.policy.data.chain : null;
  if (snap.policy.state === "unconfigured") {
    return <VaultPrompt heading="Pick a vault to watch" body="Enter a Rescue vault account to see its loan and rescues." />;
  }
  if (snap.policy.state === "error") {
    return (
      <VaultPrompt
        tone="danger"
        heading={policy ? `We couldn't open ${policy}` : "We couldn't load the dashboard"}
        body={policy ? "It isn't a Backstop vault on NEAR mainnet." : "The server could not read its data; the details say why."}
        details={snap.policy.message}
        defaultValue={policy}
      />
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="tabular-nums">
          Updated {formatUtc(snap.fetchedAt)} · refreshes every 30s
          {refreshError && <span className="ml-2 text-warn">{refreshError}</span>}
        </span>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={loading ? "animate-spin" : undefined} aria-hidden />
          Refresh
        </Button>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <HealthCard position={snap.position} policy={snap.policy} chain={chain} />
        <PositionCard position={snap.position} chain={chain} />
        <LimitsCard policy={snap.policy} />
        <AddressesCard policy={snap.policy} />
      </div>
      <section id="history" className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Rescue history</h2>
          <p className="text-sm text-muted-foreground">Each rescue links to its transactions.</p>
        </div>
        <RescueHistory history={snap.history} chain={chain} />
      </section>
    </div>
  );
}
