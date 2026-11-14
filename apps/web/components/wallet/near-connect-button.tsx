"use client";

import { LogOut, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNear } from "@/components/wallet/near-provider";

export function NearConnectButton() {
  const { state, connect, disconnect } = useNear();
  if (state.status === "loading") return <Button variant="outline" disabled>Loading wallets...</Button>;
  if (state.status === "signed-in") {
    return (
      <Button variant="outline" onClick={() => void disconnect()}>
        <LogOut /> Disconnect NEAR wallet
      </Button>
    );
  }
  return (
    <Button onClick={connect}>
      <Wallet /> Connect NEAR wallet
    </Button>
  );
}
