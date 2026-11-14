"use client";

import { Loader2, LogOut, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNear } from "@/components/wallet/near-provider";

export function NearConnectButton() {
  const { state, connect, connectPhase, resetConnect, disconnect } = useNear();
  if (state.status === "loading") return <Button variant="outline" disabled>Loading wallets...</Button>;
  if (state.status === "signed-in") {
    return (
      <Button variant="outline" onClick={() => void disconnect()}>
        <LogOut /> Disconnect NEAR wallet
      </Button>
    );
  }
  if (connectPhase !== "idle") {
    return (
      <div className="space-y-2">
        <Button disabled>
          <Loader2 className="animate-spin" aria-hidden /> Waiting for wallet...
        </Button>
        {connectPhase === "slow" ? (
          <div role="status" className="space-y-2 text-sm">
            <p>Still waiting for your wallet. Open it and approve or reject the request. If nothing is there, stop waiting and try again.</p>
            <Button variant="outline" size="sm" onClick={resetConnect}>
              Stop waiting
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <Button onClick={connect}>
      <Wallet /> {state.error ? "Try again" : "Connect NEAR wallet"}
    </Button>
  );
}
