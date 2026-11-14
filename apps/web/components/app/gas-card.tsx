"use client";

import { Copy } from "lucide-react";
import { useState } from "react";
import { useSwitchChain } from "wagmi";
import { AmountForm } from "@/components/app/actions";
import { ConnectWalletButton } from "@/components/app/connect-steps";
import { useEvmIdentity } from "@/components/app/evm-identity";
import { usePolicyContext } from "@/components/app/policy-context";
import { Button } from "@/components/ui/button";
import { prepareGasTopUp } from "@/lib/review";
import { walletErrorMessage } from "@/lib/wallet-errors";

/** Asks the connected wallet to switch to the loaded vault's loan chain. Only the gas top-up button uses it (J.4). */
function useSwitchToLoanChain() {
  const { chain } = usePolicyContext();
  const { mutate: switchChain, isPending: switching } = useSwitchChain();
  const [note, setNote] = useState<string | null>(null);

  function onSwitch() {
    setNote(null);
    // Synchronous from the click: popup blockers and mobile wallets need the request tied to the gesture.
    // No review opens afterwards: the chain change closes open dialogs, so the same button becomes "Review ETH transfer".
    switchChain(
      { chainId: chain.chainId },
      { onError: (err) => setNote(walletErrorMessage(err, "Your wallet would not switch", "the switch button again").message) },
    );
  }
  return { onSwitch, switching, note };
}

/** Advanced > Gas money: ETH for the rescue wallet on the loan chain. The only action that needs the wallet on that chain. */
export function GasCard() {
  const { owner, policyId, snap, verified, activated, openReview, chain } = usePolicyContext();
  const { identity } = useEvmIdentity();
  const { onSwitch, switching, note } = useSwitchToLoanChain();
  const [copied, setCopied] = useState(false);
  if (!owner || !policyId || !snap) return null;

  if (!activated) return <p>Set up your rescue wallet first.</p>;
  if (!verified) {
    return (
      <p role="alert" className="text-sm text-danger">
        Adding money is turned off: a safety check failed.
      </p>
    );
  }
  const rescueWallet = snap.config.base_address;
  if (identity.mode !== "wallet") {
    return (
      <div className="space-y-3">
        <p>
          Send ETH on {chain.name} to <code className="break-all font-mono text-xs text-foreground">{rescueWallet}</code> from any wallet, or connect one here.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <ConnectWalletButton />
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(rescueWallet ?? "").then(() => setCopied(true));
            }}
          >
            <Copy /> {copied ? "Copied" : "Copy address"}
          </Button>
        </div>
      </div>
    );
  }
  if (identity.chainId !== chain.chainId) {
    return (
      <div className="space-y-3">
        <p>Your wallet is on {identity.chainName ?? `chain ${identity.chainId ?? "unknown"}`}.</p>
        <Button onClick={onSwitch} disabled={switching}>
          {switching ? "Check your wallet..." : `Switch to ${chain.name} to send`}
        </Button>
        {note ? <p className="text-sm">{note}</p> : null}
      </div>
    );
  }
  const sender = { address: identity.address, chainId: identity.chainId };
  return (
    <div className="space-y-3">
      <p>About 0.0003 ETH on {chain.name} covers a few rescues.</p>
      <AmountForm
        id="gas-amount"
        label={`ETH to send on ${chain.name}`}
        placeholder="0.0003"
        button="Review ETH transfer"
        onSubmit={(v) => openReview({ kind: "gas_topup", prepare: () => prepareGasTopUp(policyId, owner, sender, v) })}
      />
    </div>
  );
}
