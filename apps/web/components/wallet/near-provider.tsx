"use client";

/**
 * NEAR wallet context (NEAR Connect). The site holds NO NEAR key of any kind: sign-in never adds an
 * access key, and every transaction is approved in the user's wallet (D6, D13).
 *
 * Wallet calls are made synchronously inside the caller's click handler (iOS Safari blocks popups
 * opened after an `await`): `connect()` and `send()` have no `await` before the wallet call, and the
 * wallet object is resolved at sign-in time, never at click time.
 *
 * One request at a time: `connect()` and `send()` each hold a single in-flight slot, so a double click
 * cannot open a second wallet request. After WALLET_STALL_MS the UI offers a reset that frees the slot.
 */
import { NEAR } from "@backstop/config/registry";
import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { clearJournal, consumeRedirectParams, setJournalHash, startJournal, type JournalEntry, type RedirectResult } from "@/lib/pending-tx";
import { gasUnits, type NearTx } from "@/lib/policy-client";
import { errorText, walletErrorMessage } from "@/lib/wallet-errors";
import { createInFlightGuard, interpretNearError, interpretNearOutcomes, SEND_ALREADY_OPEN, WALLET_STALL_MS, type NearAnswer, type NearSendResult } from "@/lib/wallet-flow";

export type { NearSendResult } from "@/lib/wallet-flow";
export type NearSendRequest = { kind: string; txs: NearTx[] };

export type NearState =
  | { status: "loading" }
  | { status: "signed-out"; error?: string }
  | { status: "signed-in"; accountId: string; walletName: string };

/** "waiting": the picker or wallet is open; "slow": no answer after WALLET_STALL_MS (offer a reset). */
export type ConnectPhase = "idle" | "waiting" | "slow";

type NearContextValue = {
  state: NearState;
  /** Opens the wallet picker. Call it directly from a click handler. A second call while one is open does nothing. */
  connect: () => void;
  connectPhase: ConnectPhase;
  /** Stop waiting for a connect that never answered. The wallet may still show the old request. */
  resetConnect: () => void;
  disconnect: () => Promise<void>;
  send: (req: NearSendRequest) => Promise<NearSendResult>;
  /** Stop waiting for a send that never answered: frees the slot. The pending journal is kept (it may still go through). */
  resetSend: () => void;
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

type TimerRef = { current: ReturnType<typeof setTimeout> | null };
function clearTimer(ref: TimerRef): void {
  if (ref.current) clearTimeout(ref.current);
  ref.current = null;
}

export function NearWalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<NearState>({ status: "loading" });
  const [redirect, setRedirect] = useState<RedirectResult>(null);
  const [epoch, setEpoch] = useState(0);
  const [connectPhase, setConnectPhase] = useState<ConnectPhase>("idle");
  const connectorRef = useRef<NearConnector | null>(null);
  const walletRef = useRef<NearWalletBase | null>(null);
  const accountRef = useRef<string | null>(null);
  const connectGuard = useRef(createInFlightGuard());
  const sendGuard = useRef(createInFlightGuard());
  const connectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyAccount = useCallback((wallet: NearWalletBase | null, accountId: string | null) => {
    walletRef.current = wallet;
    if (accountRef.current !== accountId) {
      setEpoch((e) => e + 1);
      // A request opened for the previous account must not block the new one (its journal stays with that account).
      sendGuard.current.reset();
    }
    accountRef.current = accountId;
    if (wallet && accountId) {
      // Signed in: whatever connect was open has done its job.
      connectGuard.current.reset();
      clearTimer(connectTimer);
      setConnectPhase("idle");
    }
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
      clearTimer(connectTimer);
    };
  }, [applyAccount]);

  const connect = useCallback(() => {
    const connector = connectorRef.current;
    if (!connector) {
      setState({ status: "signed-out", error: "The wallet list is still loading. Wait a second, then press Try again." });
      return;
    }
    const token = connectGuard.current.begin();
    if (token === null) return; // the picker or a wallet request is already open
    setConnectPhase("waiting");
    setState((s) => (s.status === "signed-out" && s.error ? { status: "signed-out" } : s));
    clearTimer(connectTimer);
    connectTimer.current = setTimeout(() => {
      if (connectGuard.current.holds(token)) setConnectPhase("slow");
    }, WALLET_STALL_MS);
    // Called synchronously from the click; the connector opens its own picker.
    connector.connect().then(
      () => {
        if (!connectGuard.current.end(token)) return;
        clearTimer(connectTimer);
        setConnectPhase("idle");
      },
      (err: unknown) => {
        if (!connectGuard.current.end(token)) return; // the user already pressed Reset: this answer is stale
        clearTimer(connectTimer);
        setConnectPhase("idle");
        const { kind, message } = walletErrorMessage(err, "Could not connect");
        if (kind === "rejected") return; // closing the picker is not an error (row 6)
        setState((s) => (s.status === "signed-in" ? s : { status: "signed-out", error: message }));
      },
    );
  }, []);

  const resetConnect = useCallback(() => {
    connectGuard.current.reset();
    clearTimer(connectTimer);
    setConnectPhase("idle");
    setState((s) =>
      s.status === "signed-in"
        ? s
        : { status: "signed-out", error: "Stopped waiting. If your wallet still shows a connection request, finish or reject it there, then press Try again." },
    );
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
      return Promise.resolve<NearSendResult>({ status: "failed", message: "Your NEAR wallet is not connected. Connect it, then try again.", details: "no wallet", hashes: [] });
    }
    const first = req.txs[0]?.calls[0];
    if (!first) return Promise.resolve<NearSendResult>({ status: "failed", message: "Nothing to send. Close this window and start again.", details: "empty request", hashes: [] });
    const token = sendGuard.current.begin();
    if (token === null) return Promise.resolve<NearSendResult>({ status: "pending", message: SEND_ALREADY_OPEN });
    let journal: JournalEntry;
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
      sendGuard.current.end(token);
      return Promise.resolve<NearSendResult>({ status: "failed", message: errorText(err), details: "journal busy", hashes: [] });
    }

    const toActions = (tx: NearTx) =>
      tx.calls.map((c) => ({
        type: "FunctionCall" as const,
        params: { methodName: c.methodName, args: c.args, gas: gasUnits(c), deposit: c.depositYocto },
      }));

    let request: Promise<unknown>;
    try {
      request =
        req.txs.length === 1
          ? wallet.signAndSendTransaction({ network: "mainnet", signerId, receiverId: req.txs[0]!.receiverId, actions: toActions(req.txs[0]!) })
          : wallet.signAndSendTransactions({
              network: "mainnet",
              signerId,
              transactions: req.txs.map((t) => ({ receiverId: t.receiverId, actions: toActions(t) })),
            });
    } catch (err) {
      // A wallet that throws before returning a promise has not sent anything it could report.
      request = Promise.reject(err);
    }

    // The journal is updated even when the answer arrives after a reset or an account switch: it belongs to `signerId`.
    const settle = (answer: NearAnswer): NearSendResult => {
      sendGuard.current.end(token);
      if (answer.hash) setJournalHash(journal, answer.hash);
      if (answer.clearJournal) clearJournal(signerId);
      return answer.result;
    };
    return request.then(
      (outcomes) => settle(interpretNearOutcomes(outcomes, req.txs.length)),
      (err: unknown) => settle(interpretNearError(err)),
    );
  }, []);

  const resetSend = useCallback(() => sendGuard.current.reset(), []);

  const value = useMemo(
    () => ({ state, connect, connectPhase, resetConnect, disconnect, send, resetSend, redirect, epoch }),
    [state, connect, connectPhase, resetConnect, disconnect, send, resetSend, redirect, epoch],
  );
  return <NearContext.Provider value={value}>{children}</NearContext.Provider>;
}
