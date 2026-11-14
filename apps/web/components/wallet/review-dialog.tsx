"use client";

/**
 * The one confirmation screen every transaction goes through (E.4). Nothing is sent from any other
 * code path. It re-reads chain state when it opens and every 15 s while open; if what the user
 * is looking at changes, the confirm button stays disabled until they accept the new numbers.
 * The wallet is called synchronously from the confirm click (no `await` before it: popup blockers).
 * One wallet request at a time (a second click does nothing); after WALLET_STALL_MS without an answer the
 * user can stop waiting, which keeps the pending journal (the request may still go through).
 */
import { chainTxUrl, nearTxUrl, type LoanChain } from "@backstop/config/registry";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, ExternalLink, Loader2, ShieldAlert } from "lucide-react";
import { Dialog } from "radix-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSendTransaction, useSwitchChain } from "wagmi";
import { useEvmIdentity } from "@/components/app/evm-identity";
import { useNear } from "@/components/wallet/near-provider";
import { Button } from "@/components/ui/button";
import { ChainBadge } from "@/components/chain-badge";
import { explorerHost, resolveChain } from "@/lib/chain";
import { readLoanReceipt } from "@/lib/loan-client";
import { clearJournal, loadJournal, setJournalHash, startJournal } from "@/lib/pending-tx";
import { gasUnits } from "@/lib/policy-client";
import { wagmiConfig } from "@/lib/wagmi";
import type { Prepared, PreparedEvm, PreparedNear, ReviewRequest } from "@/lib/review";
import { groupAddress } from "@/lib/validate";
import { errorText, walletErrorMessage } from "@/lib/wallet-errors";
import { createInFlightGuard, ethereumWalletNearHint, WALLET_STALL_MS, wrongNetworkMessage } from "@/lib/wallet-flow";

const REFRESH_MS = 15_000;
const RECEIPT_POLL_MS = 4_000;
const RECEIPT_POLL_MAX = 45; // about 3 minutes

type Phase =
  | { name: "reviewing" }
  | { name: "waiting" }
  | { name: "success"; links: Array<{ label: string; href: string }> }
  | { name: "failed"; message: string; details?: string }
  | { name: "unknown"; message: string }
  /** The wallet already had a request open; nothing was sent. "Try again" re-sends after the user clears it. */
  | { name: "wallet-busy"; message: string }
  | { name: "evm-pending"; hash: `0x${string}`; chainId: number };

/** Exactly what will be signed, for the "raw JSON" toggle. */
function rawJson(p: PreparedNear | PreparedEvm): string {
  if (p.network === "evm") return JSON.stringify({ chainId: p.chainId, to: p.to, value: p.valueWei.toString(), data: p.data ?? "0x" }, null, 2);
  return JSON.stringify(
    p.txs.map((t) => ({
      receiverId: t.receiverId,
      actions: t.calls.map((c) => ({ type: "FunctionCall", params: { methodName: c.methodName, args: c.args, gas: gasUnits(c), deposit: c.depositYocto } })),
    })),
    null,
    2,
  );
}

/** The visible name of a network: our registry first, then the wallet config (origin chains), never a guess. */
function networkName(chainId: number): string {
  return resolveChain(chainId)?.name ?? wagmiConfig.chains.find((c) => c.id === chainId)?.name ?? `chain ${chainId}`;
}

function Mono({ children }: { children: string }) {
  if (/^https:\/\//.test(children)) {
    return (
      <a className="inline-flex items-center gap-1 break-all text-xs text-primary underline" href={children} target="_blank" rel="noreferrer noopener">
        {new URL(children).hostname} <ExternalLink className="size-3 shrink-0" aria-hidden />
      </a>
    );
  }
  const isEvm = /^0x[0-9a-fA-F]{40}$/.test(children);
  return <span className="break-all font-mono text-xs">{isEvm ? groupAddress(children) : children}</span>;
}

/** `loanChain` is the loaded policy's chain: the header badge for NEAR reviews of that policy. EVM reviews badge their own network. */
export function ReviewDialog({ request, loanChain, onClose }: { request: ReviewRequest; loanChain: LoanChain; onClose: () => void }) {
  const near = useNear();
  const { identity, epoch: evmEpoch } = useEvmIdentity();
  const queryClient = useQueryClient();
  const { mutate: sendEth } = useSendTransaction();

  const [shown, setShown] = useState<Prepared | null>(null);
  const [latest, setLatest] = useState<Prepared | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: "reviewing" });
  const [notice, setNotice] = useState<string | null>(null);
  /** The network the transaction needs, while the wallet is on another one: offers a switch button under the notice. */
  const [switchTo, setSwitchTo] = useState<number | null>(null);
  const { mutate: switchChain, isPending: switching } = useSwitchChain();
  const [showRaw, setShowRaw] = useState(false);
  const [stalled, setStalled] = useState(false);
  const startEpochs = useRef({ near: near.epoch, evm: evmEpoch });
  const liveEpochs = useRef({ near: near.epoch, evm: evmEpoch });
  const journalAccount = useRef<string | null>(null);
  const guard = useRef(createInFlightGuard());
  const attempt = useRef(0);
  /** An earlier EVM request from this wallet that never got an answer blocks a new one: offer to clear it. */
  const [stuck, setStuck] = useState<{ account: string; hash: string | undefined } | null>(null);

  const load = useCallback((): void => {
    request.prepare().then(
      (next) => {
        setLoadError(null);
        setLatest(next);
        setShown((cur) => cur ?? next);
      },
      (err: unknown) => setLoadError(`Could not read the chain: ${errorText(err)}`),
    );
  }, [request]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (phase.name !== "reviewing") return;
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load, phase.name]);

  // Row 10: an account or network switch closes the dialog, and any answer still on its way is ignored.
  useEffect(() => {
    liveEpochs.current = { near: near.epoch, evm: evmEpoch };
    if (near.epoch !== startEpochs.current.near || evmEpoch !== startEpochs.current.evm) onClose();
  }, [near.epoch, evmEpoch, onClose]);

  // No answer for a while: say so, and offer a way out (the journal is kept, so nothing is lost).
  useEffect(() => {
    if (phase.name !== "waiting") return;
    const t = setTimeout(() => setStalled(true), WALLET_STALL_MS);
    return () => {
      clearTimeout(t);
      setStalled(false);
    };
  }, [phase.name]);

  // Poll the loan-chain receipt after an ETH transfer (row 14).
  useEffect(() => {
    if (phase.name !== "evm-pending") return;
    const chain = resolveChain(phase.chainId);
    if (!chain) return;
    let tries = 0;
    const hash = phase.hash;
    const id = setInterval(() => {
      tries++;
      void readLoanReceipt(chain, hash).then((status) => {
        if (status === null && tries < RECEIPT_POLL_MAX) return;
        clearInterval(id);
        if (journalAccount.current) clearJournal(journalAccount.current);
        void queryClient.invalidateQueries();
        if (status === "success") setPhase({ name: "success", links: [{ label: `View on ${explorerHost(chain)}`, href: chainTxUrl(chain, hash) }] });
        else if (status === "reverted") setPhase({ name: "failed", message: "The transaction was mined but reverted. Nothing was sent.", details: hash });
        else setPhase({ name: "unknown", message: `Still not confirmed after a few minutes. Check the transaction on ${explorerHost(chain)} before trying again.` });
      });
    }, RECEIPT_POLL_MS);
    return () => clearInterval(id);
  }, [phase, queryClient]);

  const changed = shown !== null && latest !== null && shown.ok && latest.ok && shown.fingerprint !== latest.fingerprint;
  const nowRefused = shown?.ok === true && latest?.ok === false;
  const ready = shown?.ok === true && !changed && !nowRefused && (phase.name === "reviewing" || phase.name === "wallet-busy");

  function stopWaiting() {
    guard.current.reset();
    if (shown?.ok && shown.network === "near") near.resetSend();
    // The same attempt stays current: if the wallet answers later, this dialog still shows the real result.
    setPhase({ name: "unknown", message: "Stopped waiting. Your wallet may still show the request; if you approve it there, it can still go through." });
  }

  function confirm() {
    // Every early exit says why: a click that does nothing looks like a jammed app.
    if (shown?.ok !== true) return setNotice("Still preparing this transaction. Wait a second, then press Approve again.");
    if (changed) return setNotice("The details changed while this window was open. Close it and start again.");
    if (nowRefused) return setNotice("This can no longer be sent as shown. Close this window and start again.");
    if (!ready) return setNotice(`Not ready to send (${phase.name}). Close this window and start again.`);
    const token = guard.current.begin();
    // Kept as a hard stop (a double click must never open two wallet requests), but it says so.
    if (token === null) return setNotice("Your wallet is still handling an earlier request from this window. Open MetaMask or Rabby and approve or reject it, or close this window and start again.");
    const mine = ++attempt.current;
    const startedAt = startEpochs.current;
    /** False once a newer attempt started or the account or network changed: that answer must not touch this screen. */
    const current = () => attempt.current === mine && liveEpochs.current.near === startedAt.near && liveEpochs.current.evm === startedAt.evm;
    setNotice(null);
    setSwitchTo(null);
    setStuck(null);
    if (shown.network === "near") {
      setPhase({ name: "waiting" });
      request.beforeSend?.();
      void near
        .send({ kind: request.kind, txs: shown.txs })
        .then((res) => {
          guard.current.end(token);
          if (!current()) return;
          if (res.status === "pending") {
            request.onRejected?.(); // nothing was sent: undo what beforeSend remembered
            setPhase({ name: "wallet-busy", message: res.message });
          } else if (res.status === "rejected") {
            request.onRejected?.();
            setPhase({ name: "reviewing" });
            setNotice("Cancelled in wallet. Your inputs are kept; review again when ready.");
          } else if (res.status === "success") {
            void queryClient.invalidateQueries();
            request.onSuccess?.();
            setPhase({ name: "success", links: res.hashes.map((h, i) => ({ label: res.hashes.length > 1 ? `NearBlocks (transaction ${i + 1})` : "View on NearBlocks", href: nearTxUrl(h) })) });
          } else if (res.status === "failed") {
            setPhase({ name: "failed", message: res.message, details: res.details });
          } else {
            setPhase({ name: "unknown", message: res.message });
          }
        });
      return;
    }
    // EVM: ETH to the policy's derived address.
    if (identity.mode !== "wallet") {
      guard.current.end(token);
      setNotice("Connect your wallet first, then try again.");
      return;
    }
    if (identity.chainId !== shown.chainId) {
      guard.current.end(token);
      const have = identity.chainName ?? (identity.chainId !== undefined ? (resolveChain(identity.chainId)?.name ?? wagmiConfig.chains.find((c) => c.id === identity.chainId)?.name ?? null) : null);
      setNotice(wrongNetworkMessage(have, networkName(shown.chainId)));
      setSwitchTo(shown.chainId);
      return;
    }
    const account = identity.address.toLowerCase();
    try {
      const entry = startJournal({ kind: request.kind, chain: "evm", account, contractId: shown.to, method: "eth_sendTransaction", args: { value: shown.valueWei.toString() }, evmChainId: shown.chainId });
      journalAccount.current = account;
      setPhase({ name: "waiting" });
      sendEth(
        { to: shown.to, value: shown.valueWei, chainId: shown.chainId as (typeof wagmiConfig.chains)[number]["id"], ...(shown.data !== undefined && { data: shown.data }) },
        {
          onSuccess: (hash) => {
            guard.current.end(token);
            setJournalHash(entry, hash);
            request.onSubmitted?.(hash); // the transaction exists whatever this screen shows now
            if (!current()) return; // the journal keeps the hash; the pending banner follows it up
            if (resolveChain(shown.chainId)) {
              setPhase({ name: "evm-pending", hash, chainId: shown.chainId });
              return;
            }
            // Receipts are only polled on loan chains. Other chains: the 1Click status panel tracks the deposit.
            clearJournal(account);
            const explorer = wagmiConfig.chains.find((c) => c.id === shown.chainId)?.blockExplorers?.default.url;
            setPhase({ name: "success", links: explorer ? [{ label: "View on the block explorer", href: `${explorer}/tx/${hash}` }] : [] });
          },
          onError: (err) => {
            guard.current.end(token);
            // The wallet refused before sending (a "no", an open request, a blocked popup or an error): nothing is pending.
            clearJournal(account);
            if (!current()) return;
            const { kind, message } = walletErrorMessage(err, "Your wallet could not send this");
            if (kind === "rejected") {
              setPhase({ name: "reviewing" });
              setNotice("Cancelled in wallet. Your inputs are kept; review again when ready.");
            } else if (kind === "pending") {
              setPhase({ name: "wallet-busy", message });
            } else {
              setPhase({ name: "failed", message });
            }
          },
        },
      );
    } catch (err) {
      guard.current.end(token);
      setNotice(errorText(err));
      const earlier = loadJournal(account).entry;
      if (earlier) setStuck({ account, hash: earlier.hash });
    }
  }

  const badgeChain = shown?.ok ? (shown.network === "evm" ? resolveChain(shown.chainId) : loanChain) : null;
  const pendingChain = phase.name === "evm-pending" ? resolveChain(phase.chainId) : null;
  const finished = phase.name === "success" || phase.name === "failed";
  const busy = phase.name === "waiting" || phase.name === "evm-pending";
  const nearHint =
    shown && !shown.ok && shown.nearShort && near.state.status === "signed-in"
      ? ethereumWalletNearHint({ walletName: near.state.walletName, accountId: near.state.accountId, ...shown.nearShort })
      : null;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 max-h-[92dvh] w-[min(36rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-popover p-5 text-popover-foreground shadow-xl max-sm:top-auto max-sm:bottom-0 max-sm:w-screen max-sm:translate-y-0 max-sm:rounded-b-none"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Dialog.Title className="text-base font-semibold">Review before you approve</Dialog.Title>
            {badgeChain ? <ChainBadge chain={badgeChain} /> : null}
          </div>
          <Dialog.Description className="sr-only">Check the details, then approve in your wallet.</Dialog.Description>

          {shown === null && !loadError ? (
            <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Checking the chain...
            </p>
          ) : null}
          {loadError && shown === null ? (
            <div role="alert" className="mt-4 space-y-3 text-sm">
              <p className="text-danger">{loadError}</p>
              <Button variant="outline" size="sm" onClick={load}>Retry</Button>
            </div>
          ) : null}

          {shown && !shown.ok ? (
            <div role="alert" className="mt-4 flex gap-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
              <div>
                <p className="font-medium text-danger">This cannot be sent</p>
                <p className="mt-1 text-muted-foreground">{shown.reason}</p>
                {nearHint ? <p className="mt-2 text-muted-foreground">{nearHint}</p> : null}
                <Button variant="outline" size="sm" className="mt-3" onClick={() => { setShown(null); load(); }}>Check again</Button>
              </div>
            </div>
          ) : null}

          {shown?.ok ? (
            <div className="mt-3 space-y-4">
              <p className="text-base font-medium">{shown.sentence}</p>
              <dl className="divide-y rounded-lg border text-sm">
                {shown.rows.map(([label, value], i) => (
                  <div key={`${label}-${i}`} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:justify-between sm:gap-4">
                    <dt className="shrink-0 text-muted-foreground">{label}</dt>
                    <dd className="min-w-0 sm:text-right">
                      <Mono>{value}</Mono>
                    </dd>
                  </div>
                ))}
              </dl>
              {shown.dangers.map((d) => (
                <p key={d} role="alert" className="flex gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm font-medium text-danger">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {d}
                </p>
              ))}
              {shown.notes.map((n) => (
                <p key={n} className="text-sm text-muted-foreground">{n}</p>
              ))}
              <div>
                <button type="button" onClick={() => setShowRaw((v) => !v)} className="text-xs text-muted-foreground underline underline-offset-4">
                  {showRaw ? "Hide" : "Show"} raw JSON
                </button>
                {showRaw ? <pre className="mt-2 max-h-48 overflow-auto rounded-lg border bg-muted p-3 font-mono text-xs">{rawJson(shown)}</pre> : null}
              </div>

              {changed && latest?.ok ? (
                <div role="alert" className="space-y-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">
                  <p className="font-medium text-warn">Something changed on-chain since you opened this.</p>
                  <p className="text-muted-foreground">Review the updated details before you approve.</p>
                  <Button size="sm" variant="outline" onClick={() => setShown(latest)}>Show updated review</Button>
                </div>
              ) : null}
              {nowRefused && latest && !latest.ok ? (
                <p role="alert" className="text-sm text-danger">Not sendable any more: {latest.reason}</p>
              ) : null}
              {loadError ? <p className="text-xs text-warn">{loadError}. The last check is still shown.</p> : null}
            </div>
          ) : null}

          {phase.name === "reviewing" && shown?.ok ? (
            <p className="mt-4 text-xs text-muted-foreground">
              Your wallet will show its own prompt. Check that it shows the same contract and method. If it differs, reject it.
            </p>
          ) : null}
          {stuck && phase.name === "reviewing" ? (
            <div className="mt-2 space-y-2 text-sm">
              <p className="text-muted-foreground">
                {stuck.hash
                  ? `An earlier transaction (${stuck.hash.slice(0, 10)}...) from this wallet was sent. Check it in your wallet's activity first.`
                  : "An earlier request from this wallet never got an answer. If your wallet shows nothing pending, clear it and approve again."}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  clearJournal(stuck.account);
                  setStuck(null);
                  setNotice("Cleared. Press Approve in wallet again.");
                }}
              >
                Clear it and try again
              </Button>
            </div>
          ) : null}
          {switchTo !== null && phase.name === "reviewing" ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={switching}
              onClick={() =>
                switchChain(
                  { chainId: switchTo as (typeof wagmiConfig.chains)[number]["id"] },
                  { onError: (e) => setNotice(walletErrorMessage(e, "Your wallet would not switch", "the switch button again").message) },
                )
              }
            >
              {switching ? "Check your wallet..." : `Switch to ${networkName(switchTo)}`}
            </Button>
          ) : null}

          {phase.name === "waiting" ? (
            <div role="status" className="mt-4 space-y-2 text-sm">
              <p className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Waiting for your wallet. Approve or reject there.
              </p>
              {stalled ? (
                <>
                  <p className="text-warn">
                    Still waiting for your wallet. Open it and look for the request. If you already approved it, it may still go through, so check
                    your wallet&apos;s history before trying again.
                  </p>
                  <Button variant="outline" size="sm" onClick={stopWaiting}>Stop waiting</Button>
                </>
              ) : null}
            </div>
          ) : null}
          {phase.name === "wallet-busy" ? (
            <p role="alert" className="mt-4 text-sm text-warn">{phase.message}</p>
          ) : null}
          {phase.name === "evm-pending" ? (
            <p role="status" className="mt-4 text-sm">
              <Loader2 className="mr-2 inline size-4 animate-spin" aria-hidden />
              Submitted, waiting for confirmation.{" "}
              {pendingChain ? (
                <a className="text-primary underline" href={chainTxUrl(pendingChain, phase.hash)} target="_blank" rel="noreferrer noopener">{explorerHost(pendingChain)}</a>
              ) : null}
              . Do not send it again.
            </p>
          ) : null}
          {phase.name === "success" ? (
            <div role="status" className="mt-4 space-y-2 text-sm">
              <p className="font-medium text-safe">Done.</p>
              <ul className="space-y-1">
                {phase.links.map((l) => (
                  <li key={l.href}>
                    <a className="inline-flex items-center gap-1 text-primary underline" href={l.href} target="_blank" rel="noreferrer noopener">
                      {l.label} <ExternalLink className="size-3" aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {phase.name === "failed" ? (
            <div role="alert" className="mt-4 space-y-1 text-sm">
              <p className="font-medium text-danger">{phase.message}</p>
              {phase.details ? <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">details</summary><p className="mt-1 break-all font-mono">{phase.details}</p></details> : null}
            </div>
          ) : null}
          {phase.name === "unknown" ? (
            <p role="alert" className="mt-4 text-sm text-warn">
              {phase.message} The action is remembered on this device: do not sign it again until you have checked.
            </p>
          ) : null}

          {/* Next to the buttons, so the reason for a click that did not go through is where the user is looking. */}
          {notice ? <p role="status" className="mt-4 rounded-md bg-muted px-3 py-2 text-sm">{notice}</p> : null}

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            {finished || phase.name === "unknown" ? (
              <Button onClick={onClose}>Close</Button>
            ) : (
              <>
                <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                {/* Disabled only while the wallet is open; gone once the transaction is submitted (it must not be sent twice). Any other click explains itself (see confirm). */}
                {phase.name === "evm-pending" ? null : (
                  <Button onClick={confirm} disabled={phase.name === "waiting"}>
                    {phase.name === "waiting" ? "Waiting for wallet..." : phase.name === "wallet-busy" ? "Try again" : "Approve in wallet"}
                  </Button>
                )}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
