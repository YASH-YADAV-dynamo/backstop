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

/** Step 1. Signed out it is the open step; signed in it is one line with "Change". */
export function NearStep() {
  const { state } = useNear();
  const [editing, setEditing] = useState(false);
  if (state.status === "signed-in") {
    return (
      <DoneLine open={editing} onChange={() => setEditing((e) => !e)} panel={<NearConnectButton />}>
        Connected as <code className="font-mono text-foreground">{state.accountId}</code>
      </DoneLine>
    );
  }
  return (
    <StepCard title="Connect your NEAR wallet" description="Your NEAR account owns your Rescue vault.">
      {state.status === "signed-out" && state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <NearConnectButton />
    </StepCard>
  );
}

/** "Connect a wallet": opens the wallet picker. Used wherever an action has to send from an EVM wallet. */
export function ConnectWalletButton({ variant = "default" }: { variant?: "default" | "outline" }) {
  const { identity } = useEvmIdentity();
  const [open, setOpen] = useState(false);
  const connecting = identity.mode === "none" && identity.connecting;
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)} disabled={connecting}>
        {connecting ? "Waiting for wallet..." : "Connect a wallet"}
      </Button>
      <EvmConnectDialog open={open} onOpenChange={setOpen} />
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
