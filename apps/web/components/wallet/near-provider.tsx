"use client";

/**
 * NEAR wallet context (NEAR Connect). The site holds NO NEAR key of any kind: sign-in never adds an
 * access key, and every transaction is approved in the user's wallet (D6, D13).
 *
 * Wallet calls are made synchronously inside the caller's click handler (iOS Safari blocks popups
 * opened after an `await`): `send()` has no `await` before the wallet call, and the wallet object is
 * resolved at sign-in time, never at click time.
 */
import { NEAR } from "@backstop/config/registry";
import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { clearJournal, consumeRedirectParams, setJournalHash, startJournal, type RedirectResult } from "@/lib/pending-tx";
import { explainContractError, gasUnits, type NearTx } from "@/lib/policy-client";
import { errorText, isPopupBlocked, isUserRejection, parseOutcome } from "@/lib/wallet-errors";

export type NearSendRequest = { kind: string; txs: NearTx[] };

export type NearSendResult =
  | { status: "success"; hashes: string[] }
  | { status: "rejected" }
  /** The contract (or token) refused. `details` is the raw text. */
  | { status: "failed"; message: string; details: string; hashes: string[] }
  /** The wallet did not give us a final result: it may or may not have been sent. The journal keeps the action. */
  | { status: "unknown"; message: string };

export type NearState =
  | { status: "loading" }
  | { status: "signed-out"; error?: string }
  | { status: "signed-in"; accountId: string; walletName: string };

type NearContextValue = {
  state: NearState;
  /** Opens the wallet picker. Call it directly from a click handler. */
  connect: () => void;
  disconnect: () => Promise<void>;
  send: (req: NearSendRequest) => Promise<NearSendResult>;
  /** Result of a redirect-style wallet that navigated back to this page (row 16), read once. */
  redirect: RedirectResult;
  /** Bumps when the NEAR account changes or signs out: dependants must drop in-flight UI (row 10). */
  epoch: number;
};

const NearContext = createContext<NearContextValue | null>(null);

export function useNear(): NearContextValue {
  const ctx = useContext(NearContext);
  if (!ctx) throw new Error("useNear must be used inside <NearWalletProvider> (mounted by the /app layout).");
  return ctx;
}

export function NearWalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<NearState>({ status: "loading" });
  const [redirect, setRedirect] = useState<RedirectResult>(null);
  const [epoch, setEpoch] = useState(0);
  const connectorRef = useRef<NearConnector | null>(null);
  const walletRef = useRef<NearWalletBase | null>(null);
  const accountRef = useRef<string | null>(null);

  const applyAccount = useCallback((wallet: NearWalletBase | null, accountId: string | null) => {
    walletRef.current = wallet;
    if (accountRef.current !== accountId) setEpoch((e) => e + 1);
    accountRef.current = accountId;
    setState(wallet && accountId ? { status: "signed-in", accountId, walletName: wallet.manifest.name } : { status: "signed-out" });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void import("@hot-labs/near-connect").then(async ({ NearConnector }) => {
      if (cancelled) return;
      setRedirect(consumeRedirectParams());
      const connector = new NearConnector({
        network: "mainnet",
        providers: { mainnet: [...NEAR.rpcUrls] },
        // No signIn / addFunctionCallKey anywhere: the site never asks for a NEAR key (D6).
        // Only wallets that declare both features are listed. `mainnet: true` is deliberately NOT
        // required: on 2026-11-13 the manifest sets it for only 5 of 13 wallets and the connector does
        // not need it on mainnet, so requiring it hid HOT, MyNearWallet, Intear, OKX and others.
        features: { signAndSendTransaction: true, signInWithoutAddKey: true },
        // "Ethereum Wallets" (NEAR account from an EVM address) stays listed (D22). Whether such accounts
        // can attach 1 yocto and pay gas for owner calls is UNVERIFIED (U11): docs claim nothing until tested.
        autoConnect: true,
      });
      connectorRef.current = connector;
      connector.on("wallet:signIn", ({ wallet, accounts }) => applyAccount(wallet, accounts[0]?.accountId ?? null));
      connector.on("wallet:signOut", () => applyAccount(null, null));
      try {
        await connector.whenManifestLoaded;
        const { wallet, accounts } = await connector.getConnectedWallet();
        if (!cancelled) applyAccount(wallet, accounts[0]?.accountId ?? null);
      } catch {
        // No remembered wallet, or it no longer has an account: start signed out.
        if (!cancelled) setState((s) => (s.status === "loading" ? { status: "signed-out" } : s));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [applyAccount]);

  const connect = useCallback(() => {
    const connector = connectorRef.current;
    if (!connector) {
      setState({ status: "signed-out", error: "The wallet list is still loading. Wait a second and try again." });
      return;
    }
    // Called synchronously from the click; the connector opens its own picker.
    connector.connect().catch((err: unknown) => {
      if (isUserRejection(err)) return; // closing the picker is not an error (row 6)
      const text = errorText(err);
      setState({
        status: "signed-out",
        error: isPopupBlocked(err)
          ? "Your browser blocked the wallet popup. Allow popups for this site, or open this page in your wallet's browser."
          : `Could not connect: ${text}`,
      });
    });
  }, []);

  const disconnect = useCallback(async () => {
    const connector = connectorRef.current;
    try {
      await connector?.disconnect();
    } catch {
      // Wallet already gone: drop our side anyway.
    }
    applyAccount(null, null);
  }, [applyAccount]);

  const send = useCallback((req: NearSendRequest): Promise<NearSendResult> => {
    // NOTE: no `await` before the wallet call below (popup blockers).
    const wallet = walletRef.current;
    const signerId = accountRef.current;
    if (!wallet || !signerId) {
      return Promise.resolve<NearSendResult>({ status: "failed", message: "Your NEAR wallet is not connected. Connect it and try again.", details: "no wallet", hashes: [] });
    }
    const first = req.txs[0]?.calls[0];
    if (!first) return Promise.resolve<NearSendResult>({ status: "failed", message: "Nothing to send.", details: "empty request", hashes: [] });
    let journal;
    try {
      journal = startJournal({
        kind: req.kind,
        chain: "near",
        account: signerId,
        contractId: req.txs[0]!.receiverId,
        method: req.txs.map((t) => t.calls.map((c) => c.methodName).join("+")).join(" then "),
        args: req.txs,
      });
    } catch (err) {
      return Promise.resolve<NearSendResult>({ status: "failed", message: errorText(err), details: "journal busy", hashes: [] });
    }

    const toActions = (tx: NearTx) =>
      tx.calls.map((c) => ({
        type: "FunctionCall" as const,
        params: { methodName: c.methodName, args: c.args, gas: gasUnits(c), deposit: c.depositYocto },
      }));

    const request: Promise<unknown[]> =
      req.txs.length === 1
        ? wallet
            .signAndSendTransaction({ network: "mainnet", signerId, receiverId: req.txs[0]!.receiverId, actions: toActions(req.txs[0]!) })
            .then((o: unknown) => [o])
        : wallet
            .signAndSendTransactions({
              network: "mainnet",
              signerId,
              transactions: req.txs.map((t) => ({ receiverId: t.receiverId, actions: toActions(t) })),
            })
            .then((o: unknown[]) => o);

    return request.then(
      (outcomes): NearSendResult => {
        const parsed = (Array.isArray(outcomes) ? outcomes : [outcomes]).map(parseOutcome);
        const hashes = parsed.flatMap((p) => (p.hash ? [p.hash] : []));
        if (hashes[0]) setJournalHash(journal, hashes[0]);
        const failure = parsed.find((p) => p.failure)?.failure;
        if (failure) {
          clearJournal(signerId);
          const { message } = explainContractError(failure);
          return { status: "failed", message, details: failure, hashes };
        }
        if (hashes.length === 0) {
          return {
            status: "unknown",
            message: "Your wallet did not report a result. If it asked you to approve, the transaction may be on its way; we will check the chain.",
          };
        }
        clearJournal(signerId);
        return { status: "success", hashes };
      },
      (err: unknown): NearSendResult => {
        if (isUserRejection(err)) {
          clearJournal(signerId);
          return { status: "rejected" };
        }
        if (isPopupBlocked(err)) {
          clearJournal(signerId);
          return {
            status: "failed",
            message: "Your browser blocked the wallet popup. Allow popups for this site, or open this page in your wallet's browser.",
            details: errorText(err),
            hashes: [],
          };
        }
        // Anything else may have happened after the wallet submitted (flaky network): keep the journal (row 14).
        return { status: "unknown", message: `The wallet reported an error (${errorText(err)}). It may still have been sent; check your wallet's history before trying again.` };
      },
    );
  }, []);

  const value = useMemo(() => ({ state, connect, disconnect, send, redirect, epoch }), [state, connect, disconnect, send, redirect, epoch]);
  return <NearContext.Provider value={value}>{children}</NearContext.Provider>;
}
