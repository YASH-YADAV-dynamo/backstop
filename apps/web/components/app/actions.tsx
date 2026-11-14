"use client";

import { formatUsdc } from "@backstop/core";
import { useState, type FormEvent, type ReactNode } from "react";
import { formatGwei, formatUnits } from "viem";
import { BetaGate } from "@/components/app/beta-ack";
import { FundFromChain } from "@/components/app/fund-from-chain";
import { Row } from "@/components/app/manage-panel";
import { usePolicyContext } from "@/components/app/policy-context";
import { StepCard } from "@/components/app/step-card";
import { toast } from "@/components/ui/toaster";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/format";
import { useNearAccount } from "@/lib/queries";
import {
  prepareDeposit,
  preparePause,
  prepareSetAgent,
  prepareSetBorrower,
  prepareSetLimits,
  prepareUnpause,
  prepareWithdraw,
  prepareWithdrawNear,
} from "@/lib/review";
import type { PolicyLimits } from "@/lib/policy-client";

const inputClass = "h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm sm:flex-1";

export function AmountForm({
  id,
  label,
  placeholder,
  button,
  onSubmit,
  maxLabel,
  onMax,
  disabled,
  hint,
}: {
  id: string;
  label: string;
  placeholder: string;
  button: string;
  onSubmit: (value: string) => void;
  maxLabel?: string;
  onMax?: () => string | null;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="space-y-2"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input id={id} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} autoComplete="off" className={inputClass} />
        {onMax ? (
          <Button type="button" variant="ghost" onClick={() => setValue(onMax() ?? value)}>
            {maxLabel ?? "Max"}
          </Button>
        ) : null}
        <Button type="submit" disabled={disabled}>
          {button}
        </Button>
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </form>
  );
}

function limitsFormValues(l: PolicyLimits) {
  return {
    triggerHf: (l.trigger_hf_bps / 10_000).toFixed(2),
    targetHf: (l.target_hf_bps / 10_000).toFixed(2),
    maxPerRescue: formatUsdc(l.max_per_rescue),
    dailyCap: formatUsdc(l.daily_cap),
    cooldownSecs: l.cooldown_secs.toString(),
    maxFeeGwei: formatUnits(l.max_fee_per_gas, 9),
    maxGasLimit: l.max_gas_limit.toString(),
  };
}

const LIMIT_FIELDS: Array<[keyof ReturnType<typeof limitsFormValues>, string]> = [
  ["triggerHf", "Rescue at health"],
  ["targetHf", "Repay until health"],
  ["maxPerRescue", "Max per rescue (USDC)"],
  ["dailyCap", "Daily cap (USDC)"],
  ["cooldownSecs", "Cooldown (seconds)"],
  ["maxFeeGwei", "Max fee per gas (gwei)"],
  ["maxGasLimit", "Max gas limit"],
];

function LimitsForm({ policyId, owner, limits }: { policyId: string; owner: string; limits: PolicyLimits }) {
  const { openReview } = usePolicyContext();
  const [values, setValues] = useState(() => limitsFormValues(limits));
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        openReview({ kind: "set_limits", prepare: () => prepareSetLimits(policyId, owner, values) });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {LIMIT_FIELDS.map(([key, label]) => (
          <label key={key} className="space-y-1 text-sm">
            <span className="font-medium text-foreground">{label}</span>
            <input
              inputMode="decimal"
              value={values[key]}
              onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
              autoComplete="off"
              className={inputClass}
            />
          </label>
        ))}
      </div>
      <Button type="submit">Review new limits</Button>
    </form>
  );
}

/** Add USDC from the NEAR wallet, or from another chain. Off when a safety check failed (J.7). */
function DepositPanel() {
  const { owner, policyId, snap, verified, openReview } = usePolicyContext();
  const account = useNearAccount(owner);
  const [fromChain, setFromChain] = useState(false);
  if (!owner || !policyId || !snap) return null;
  if (!verified) {
    return (
      <p role="alert" className="text-sm text-danger">
        Adding money is turned off: a safety check failed.
      </p>
    );
  }
  const walletUsdc = account.data?.usdc ?? null;
  const link = "text-sm underline underline-offset-4 hover:text-foreground";
  return (
    <BetaGate owner={owner}>
    <div className="space-y-3">
      {fromChain ? (
        <FundFromChain />
      ) : (
        <AmountForm
          id="deposit-amount"
          label="Amount (USDC)"
          placeholder="20.00"
          button="Review deposit"
          onMax={walletUsdc !== null && walletUsdc > 0n ? () => formatUsdc(walletUsdc) : undefined}
          hint={walletUsdc === null ? undefined : walletUsdc > 0n ? `In your NEAR wallet: ${formatUsdc(walletUsdc)} USDC` : "Your NEAR wallet has no USDC; fund from another chain instead."}
          onSubmit={(v) => openReview({ kind: "deposit", prepare: () => prepareDeposit(policyId, owner, v) })}
        />
      )}
      <button type="button" onClick={() => setFromChain((f) => !f)} className={link}>
        {fromChain ? "Add from my NEAR wallet" : "Fund from another chain"}
      </button>
    </div>
    </BetaGate>
  );
}

/** Wizard step 3. */
export function FundStep() {
  return (
    <StepCard title="Add USDC to your vault" description="Rescues are paid from this USDC, and only you can take it out.">
      <DepositPanel />
    </StepCard>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      {children}
    </section>
  );
}

/** Advanced > Add or withdraw money. */
export function MoneyBody() {
  const { owner, policyId, snap, openReview } = usePolicyContext();
  if (!owner || !policyId || !snap) return null;
  const vaultUsdc = snap.usdcBalance;
  return (
    <div className="space-y-6">
      <Section title="Add USDC">
        <DepositPanel />
      </Section>
      <Section title="Withdraw USDC">
        <p>Back to your NEAR wallet, any time, even while rescues are paused.</p>
        <AmountForm
          id="withdraw-amount"
          label="Amount (USDC)"
          placeholder="5.00"
          button="Review withdrawal"
          onMax={vaultUsdc > 0n ? () => formatUsdc(vaultUsdc) : undefined}
          hint={`The vault holds ${formatUsdc(vaultUsdc)} USDC.`}
          onSubmit={(v) => openReview({ kind: "withdraw", prepare: () => prepareWithdraw(policyId, owner, v), onSuccess: () => toast.success("Your USDC is on its way back to your NEAR wallet.") })}
        />
      </Section>
      <Section title="Withdraw NEAR">
        <p>Spare NEAR only. To get your whole deposit back, close the vault instead.</p>
        <AmountForm
          id="withdraw-near-amount"
          label="Amount (NEAR)"
          placeholder="0.05"
          button="Review withdrawal"
          hint={`The vault holds ${(Number(snap.account.amount) / 1e24).toFixed(4)} NEAR, mostly your refundable deposit.`}
          onSubmit={(v) => openReview({ kind: "withdraw_near", prepare: () => prepareWithdrawNear(policyId, owner, v) })}
        />
      </Section>
    </div>
  );
}

/** Advanced > Rescue limits. */
export function LimitsBody() {
  const { owner, policyId, snap } = usePolicyContext();
  if (!owner || !policyId || !snap) return null;
  const l = snap.limits;
  return (
    <div className="space-y-4">
      <p>Backstop can never go past these.</p>
      <dl className="divide-y">
        <Row label="Rescue at health">{(l.trigger_hf_bps / 10_000).toFixed(2)}</Row>
        <Row label="Repay until health">{(l.target_hf_bps / 10_000).toFixed(2)}</Row>
        <Row label="Max per rescue">{formatUsdc(l.max_per_rescue)} USDC</Row>
        <Row label="Daily cap">{formatUsdc(l.daily_cap)} USDC</Row>
        <Row label="Cooldown">{formatDuration(Number(l.cooldown_secs))}</Row>
        <Row label="Gas fee cap">{formatGwei(l.max_fee_per_gas)} gwei</Row>
        <Row label="Gas limit cap">{l.max_gas_limit.toLocaleString("en-US")}</Row>
      </dl>
      <LimitsForm key={JSON.stringify(limitsFormValues(l))} policyId={policyId} owner={owner} limits={l} />
    </div>
  );
}

function TextForm({ id, label, placeholder, button, current, onSubmit }: { id: string; label: string; placeholder: string; button: string; current: string; onSubmit: (v: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form className="space-y-2" onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit(value); }}>
      <label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input id={id} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} className={inputClass} />
        <Button type="submit">{button}</Button>
      </div>
      <p className="break-all text-xs text-muted-foreground">Current: {current}</p>
    </form>
  );
}

/** Advanced > Bot and vault settings: the rescue bot and the loan address. */
export function SettingsBody() {
  const { owner, policyId, snap, openReview, chain } = usePolicyContext();
  if (!owner || !policyId || !snap) return null;
  return (
    <div className="space-y-6">
      <Section title="Rescue bot">
        <p>The NEAR account allowed to run rescues. Run your own bot by naming it here.</p>
        <TextForm id="agent-id" label="New rescue bot account" placeholder="bot.near" button="Review change" current={snap.config.agent} onSubmit={(v) => openReview({ kind: "set_agent", prepare: () => prepareSetAgent(policyId, owner, v) })} />
      </Section>
      <Section title="Loan address">
        <p>The {chain.name} address whose Aave USDC debt rescues repay.</p>
        <TextForm id="borrower" label="New loan address" placeholder="0x..." button="Review change" current={snap.config.on_behalf_of} onSubmit={(v) => openReview({ kind: "set_borrower", prepare: () => prepareSetBorrower(policyId, owner, v) })} />
      </Section>
    </div>
  );
}

/** The always-visible emergency control on the home header: one click to the Pause review (J.7). */
export function HomePauseButton() {
  const { owner, policyId, owned, paused, snap, openReview, reviewOpen } = usePolicyContext();
  if (!owner || !policyId || !snap || !owned) return null;
  return paused ? (
    <Button size="sm" variant="outline" disabled={reviewOpen} onClick={() => openReview({ kind: "unpause", prepare: () => prepareUnpause(policyId, owner) })}>
      Resume
    </Button>
  ) : (
    <Button size="sm" variant="outline" className="border-danger/40 text-danger" disabled={reviewOpen} onClick={() => openReview({ kind: "pause", prepare: () => preparePause(policyId, owner) })}>
      Pause
    </Button>
  );
}
