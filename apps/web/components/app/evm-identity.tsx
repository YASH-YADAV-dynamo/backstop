"use client";

/**
 * Which EVM address the app is working with: a connected wallet, or a pasted address in read-only
 * "manual" mode (matrix row 2: steps 5 and sweeps are unavailable, everything else works).
 * A change of account or chain is exposed as `epoch` so open dialogs can close (row 10).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Address } from "viem";
import { useConnection, useDisconnect } from "wagmi";
import { parseEvmAddress } from "@/lib/validate";

export type EvmIdentity =
  | { mode: "wallet"; address: Address; chainId: number | undefined; /** wallet's own name for its network, e.g. "Ethereum" */ chainName: string | undefined; walletName: string }
  | { mode: "manual"; address: Address }
  | { mode: "none"; connecting: boolean };

type Ctx = {
  identity: EvmIdentity;
  epoch: number;
  /** Returns an error text, or null when the address was accepted. */
  setManual: (input: string) => string | null;
  clear: () => void;
};

const EvmIdentityContext = createContext<Ctx | null>(null);
const MANUAL_KEY = "backstop.manualEvmAddress";

const manualListeners = new Set<() => void>();
const subscribeManual = (cb: () => void) => {
  manualListeners.add(cb);
  return () => void manualListeners.delete(cb);
};
const notifyManual = () => manualListeners.forEach((cb) => cb());
/** Snapshot is the raw stored string (a primitive, so identity is stable); parsed in the provider. */
const getManualRaw = (): string | null => {
  try {
    return sessionStorage.getItem(MANUAL_KEY);
  } catch {
    return memoryManual;
  }
};
let memoryManual: string | null = null;

export function EvmIdentityProvider({ children }: { children: ReactNode }) {
  const conn = useConnection();
  const { mutate: disconnectWallet } = useDisconnect();
  const manualRaw = useSyncExternalStore(subscribeManual, getManualRaw, () => null);
  const manual = useMemo(() => {
    const parsed = manualRaw ? parseEvmAddress(manualRaw) : null;
    return parsed?.ok ? parsed.value : null;
  }, [manualRaw]);
  const [epoch, setEpoch] = useState(0);
  const last = useRef<string>("");

  const walletAddress = conn.status === "connected" ? conn.address : undefined;
  const chainId = conn.chainId;
  useEffect(() => {
    const key = `${walletAddress ?? ""}:${chainId ?? ""}`;
    if (last.current && last.current !== key) setEpoch((e) => e + 1);
    last.current = key;
  }, [walletAddress, chainId]);

  const setManual = useCallback(
    (input: string) => {
      const parsed = parseEvmAddress(input);
      if (!parsed.ok) return parsed.error;
      memoryManual = parsed.value;
      try {
        sessionStorage.setItem(MANUAL_KEY, parsed.value);
      } catch {
        // Private mode: kept in memory only.
      }
      notifyManual();
      if (conn.status === "connected") disconnectWallet();
      setEpoch((e) => e + 1);
      return null;
    },
    [conn.status, disconnectWallet],
  );

  const clear = useCallback(() => {
    memoryManual = null;
    try {
      sessionStorage.removeItem(MANUAL_KEY);
    } catch {
      // ignore
    }
    notifyManual();
    if (conn.status === "connected") disconnectWallet();
    setEpoch((e) => e + 1);
  }, [conn.status, disconnectWallet]);

  const identity: EvmIdentity = useMemo(() => {
    if (walletAddress) {
      return { mode: "wallet", address: walletAddress, chainId, chainName: conn.chain?.name, walletName: conn.connector?.name ?? "wallet" };
    }
    if (manual) return { mode: "manual", address: manual };
    return { mode: "none", connecting: conn.status === "connecting" || conn.status === "reconnecting" };
  }, [walletAddress, chainId, conn.chain?.name, manual, conn.status, conn.connector]);

  const value = useMemo(() => ({ identity, epoch, setManual, clear }), [identity, epoch, setManual, clear]);
  return <EvmIdentityContext.Provider value={value}>{children}</EvmIdentityContext.Provider>;
}

export function useEvmIdentity(): Ctx {
  const ctx = useContext(EvmIdentityContext);
  if (!ctx) throw new Error("useEvmIdentity must be used inside <EvmIdentityProvider> (mounted by AppShell).");
  return ctx;
}
