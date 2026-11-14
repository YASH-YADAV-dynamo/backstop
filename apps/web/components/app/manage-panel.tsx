"use client";

import { NEAR } from "@backstop/config/registry";
import { formatUsdc } from "@backstop/core";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { formatUnits, type Address } from "viem";
import { AddressLink } from "@/components/explorer-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { resolveChain } from "@/lib/chain";
import { formatUtc } from "@/lib/format";
import type { Check, PolicySnapshot } from "@/lib/policy-client";

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all text-foreground sm:text-right">{children}</dd>
    </div>
  );
}

const mono = "font-mono text-xs";
const unix = (secs: bigint) => (secs === 0n ? "never" : formatUtc(new Date(Number(secs) * 1000).toISOString()));
const near = (yocto: bigint) => `${Number(formatUnits(yocto, 24)).toLocaleString("en-US", { maximumFractionDigits: 4 })} NEAR`;

function CheckList({ checks }: { checks: Check[] }) {
  return (
    <ul className="space-y-2">
      {checks.map((c) => (
        <li key={c.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 text-sm">
          <Badge variant={c.state === "pass" ? "safe" : c.state === "fail" ? "danger" : "warn"}>
            {c.state === "pass" ? "passed" : c.state === "fail" ? "failed" : "not checked"}
          </Badge>
          <span className="font-medium text-foreground">{c.label}</span>
          <span className="basis-full text-muted-foreground sm:basis-auto sm:flex-1">{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/** Safety checks (C.14), read from the chain just now. Any failed check is a red, blocking state (matrix row 26). */
export function SafetyChecks({ checks }: { checks: Check[] }) {
  const failed = checks.some((c) => c.state === "fail");
  return (
    <div className="space-y-3">
      <p>Read from the chain just now, not from this website.</p>
      {failed ? (
        <p role="alert" className="text-sm font-medium text-danger">
          Don&apos;t fund this vault. Adding money is turned off until every check passes.
        </p>
      ) : null}
      <CheckList checks={checks} />
    </div>
  );
}

/** The vault's own numbers: who holds what, and what it has done today. */
export function VaultDetails({ snap, onRefresh, refreshing, stale }: { snap: PolicySnapshot; onRefresh: () => void; refreshing: boolean; stale: boolean }) {
  const { config: c, status: s } = snap;
  const chain = resolveChain(c.chain_id);
  const address = (a: string) => (chain ? <AddressLink chain={chain} address={a} /> : <span className={mono}>{a}</span>);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className={stale ? "text-warn" : undefined}>
          {stale ? "Network unreachable, retrying. Showing data from " : "Updated "}
          {formatUtc(new Date(snap.fetchedAt).toISOString())}
        </span>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={refreshing ? "animate-spin" : undefined} aria-hidden /> Refresh
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Vault</CardTitle>
          <CardDescription>On NEAR. The contract enforces these numbers.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <Row label="Vault"><a className={`${mono} text-primary hover:underline`} href={`${NEAR.explorer}/address/${snap.policyId}`} target="_blank" rel="noreferrer noopener">{snap.policyId}</a></Row>
            <Row label="Owner"><span className={mono}>{c.owner}</span></Row>
            <Row label="Rescue bot"><span className={mono}>{c.agent}</span></Row>
            <Row label="USDC in vault">{formatUsdc(snap.usdcBalance)} USDC</Row>
            <Row label="Deposit held">{near(snap.account.amount)}, returned when you close</Row>
            <Row label="Access keys">{snap.keyCount === 0 ? "none" : <span className="text-danger">{snap.keyCount}</span>}</Row>
            <Row label="Loan address">{address(c.on_behalf_of as Address)}</Row>
            <Row label="Rescue wallet">{c.base_address ? address(c.base_address) : <Badge variant="warn">not set up</Badge>}</Row>
            <Row label="Service fee">
              {c.fee_bps === 0 ? "none" : `${(c.fee_bps / 100).toFixed(2)}% of each bridged amount (only when a rescue bridges), paid to ${c.fee_account}`}
            </Row>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <CardDescription>Today is a UTC day.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <Row label="Rescue spend today">{formatUsdc(s.spent_today)} USDC ({formatUsdc(s.remaining_today)} left)</Row>
            <Row label="Rescues so far">{s.rescue_count}</Row>
            <Row label="Last rescue">{unix(s.last_rescue_at)}</Row>
            <Row label="Bridge spend today">{formatUsdc(s.bridge_spent_today)} USDC ({formatUsdc(s.bridge_remaining_today)} left)</Row>
            <Row label="Bridges so far">{s.bridge_count}</Row>
            <Row label="Last bridge">
              {s.last_bridge ? `${formatUsdc(s.last_bridge.amount_in)} USDC, ${unix(s.last_bridge.funded_at)}` : "none"}
            </Row>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
