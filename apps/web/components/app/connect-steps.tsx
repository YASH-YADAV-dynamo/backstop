"use client";

import { useState } from "react";
import { useDisconnect } from "wagmi";
import { DoneLine, StepCard } from "@/components/app/step-card";
import { useEvmIdentity } from "@/components/app/evm-identity";
import { usePolicyContext } from "@/components/app/policy-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EvmConnectDialog } from "@/components/wallet/evm-connect-dialog";
import { NearConnectButton } from "@/components/wallet/near-connect-button";
import { useNear } from "@/components/wallet/near-provider";
import { WalletArt } from "@/components/app/vault-art";
import { createDeposit, nearText } from "@/lib/create-vault";
import { getNearEnabled } from "@/lib/get-near";
import { PUBLIC_ENV } from "@/lib/public-env";

/** Step 1. Signed out it is the open step; signed in it is one line with "Change". */
export function NearStep() {
  const { state } = useNear();
  const [editing, setEditing] = useState(false);
  if (state.status === "signed-in") {
    return (
      <DoneLine open={editing} onChange={() => setEditing((e) => !e)} panel={<><p className="text-muted-foreground">Disconnect to use another NEAR account. A vault belongs to the account that created it.</p><NearConnectButton /></>}>
        Connected as <code className="font-mono text-foreground">{state.accountId}</code>
      </DoneLine>
    );
  }
  const deposit = createDeposit(PUBLIC_ENV.policyCodeBytes);
  const needs = [
    "A NEAR wallet. New to NEAR? Pick a wallet in the list and it helps you create an account.",
    "The address of your Aave loan on Base or Arbitrum.",
    (deposit !== null ? "A refundable deposit of about " + nearText(deposit, 2) + "." : "A refundable deposit in NEAR.") + (getNearEnabled() ? " You can pay it with USDC or ETH on Base from MetaMask or Rabby." : ""),
  ];
  return (
    <StepCard title="Connect wallet" description="Your NEAR account owns the vault. Only it can withdraw." art={<WalletArt className="h-20 w-28 shrink-0 sm:h-24 sm:w-32" />}>
      {state.status === "signed-out" && state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <NearConnectButton />
      <div className="space-y-2 rounded-xl border bg-muted/20 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What you need</p>
        <ol className="space-y-2 text-sm text-muted-foreground">
          {needs.map((text, i) => (
            <li key={text} className="flex gap-3">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.6875rem] font-medium text-foreground">{i + 1}</span>
              <span>{text}</span>
            </li>
          ))}
        </ol>
      </div>
    </StepCard>
  );
}

/** "Connect a wallet": opens the wallet picker. Used wherever an action has to send from an EVM wallet. */
/** EVM wallets Backstop supports. */
export const EVM_WALLETS = /metamask|rabby/i;

export function ConnectWalletButton({ variant = "default", label = "Connect loan wallet", onConnected }: { variant?: "default" | "outline"; label?: string; /** Runs once the wallet connected, before the picker closes. */ onConnected?: () => void }) {
  const { identity } = useEvmIdentity();
  const [open, setOpen] = useState(false);
  const connecting = identity.mode === "none" && identity.connecting;
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)} disabled={connecting}>
        {connecting ? "Waiting for wallet..." : label}
      </Button>
      <EvmConnectDialog open={open} onOpenChange={setOpen} only={EVM_WALLETS} onConnected={onConnected} />
    </>
  );
}

/** "Your wallet": the EVM wallet is optional and only used by the two actions that send from it. Any network is fine here. */
export function EvmStep() {
  const { identity, setManual, clear } = useEvmIdentity();
  const { mutate: disconnect } = useDisconnect();
  const { chain } = usePolicyContext();
  const [manualText, setManualText] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);

  return (
    <div className="space-y-3">
      <p>Only needed to send ETH or deposit from another chain.</p>
      {identity.mode === "wallet" ? (
        <p className="break-all text-foreground">
          {identity.walletName}: <code className="font-mono">{identity.address}</code>
        </p>
      ) : null}
      {identity.mode === "manual" ? (
        <p className="break-all text-foreground">
          <Badge variant="warn">read-only</Badge> <code className="font-mono">{identity.address}</code>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {identity.mode === "wallet" ? (
          <Button variant="outline" onClick={() => disconnect()}>
            Disconnect {identity.walletName}
          </Button>
        ) : (
          <ConnectWalletButton variant="outline" />
        )}
        {identity.mode === "manual" ? (
          <Button variant="outline" onClick={clear}>
            Stop read-only mode
          </Button>
        ) : null}
        {!showManual && identity.mode !== "manual" ? (
          <Button variant="ghost" onClick={() => setShowManual(true)}>
            Enter an address instead
          </Button>
        ) : null}
      </div>
      {showManual && identity.mode !== "manual" ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            const err = setManual(manualText);
            setManualError(err);
            if (!err) setManualText("");
          }}
        >
          <label htmlFor="manual-address" className="text-sm font-medium text-foreground">
            Loan address on {chain.name} (read-only)
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="manual-address"
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              placeholder="0x..."
              spellCheck={false}
              autoComplete="off"
              className="h-10 w-full min-w-0 rounded-md border bg-background px-3 font-mono text-sm sm:flex-1"
            />
            <Button type="submit" variant="outline">
              Use address
            </Button>
          </div>
          {manualError ? (
            <p role="alert" className="text-sm text-danger">
              {manualError}
            </p>
          ) : (
            <p className="text-xs">Read-only mode cannot send ETH or deposit from another chain.</p>
          )}
        </form>
      ) : null}
    </div>
  );
}
