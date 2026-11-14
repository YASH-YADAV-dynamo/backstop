"use client";

/** Resumes an unresolved action after a reload, a closed tab or a redirect wallet (E.5 rows 14-16). */
import { chainTxUrl, nearTxUrl } from "@backstop/config/registry";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { usePolicyContext } from "@/components/app/policy-context";
import { kindLabel } from "@/lib/app-flow";
import { useNear } from "@/components/wallet/near-provider";
import { Button } from "@/components/ui/button";
import { readLoanReceipt } from "@/lib/loan-client";
import { txResult } from "@/lib/near-rpc";
import { clearJournal, loadJournal, receiptChainFor, type JournalEntry } from "@/lib/pending-tx";
import { explainContractError } from "@/lib/policy-client";
import { wagmiConfig } from "@/lib/wagmi";

type Pending =
  | { kind: "none" }
  | { kind: "expired" }
  | { kind: "no-hash"; entry: JournalEntry }
  | { kind: "waiting"; entry: JournalEntry; url: string }
  | { kind: "check-wallet"; entry: JournalEntry }
  | { kind: "done"; entry: JournalEntry; failure: string | null };

async function check(account: string): Promise<Pending> {
  const { entry, expired } = loadJournal(account);
  if (expired) return { kind: "expired" };
  if (!entry) return { kind: "none" };
  if (!entry.hash) return { kind: "no-hash", entry };
  if (entry.chain === "near") {
    const r = await txResult(entry.hash, entry.account);
    if (!r) return { kind: "waiting", entry, url: nearTxUrl(entry.hash) };
    clearJournal(account);
    return { kind: "done", entry, failure: r.failure };
  }
  const receiptChain = receiptChainFor(entry);
  // Never poll a hash on a guessed chain: without a loan chain the user checks it in their wallet.
  if (!receiptChain) return { kind: "check-wallet", entry };
  const status = await readLoanReceipt(receiptChain, entry.hash as `0x${string}`);
  if (!status) return { kind: "waiting", entry, url: chainTxUrl(receiptChain, entry.hash) };
  clearJournal(account);
  return { kind: "done", entry, failure: status === "reverted" ? "reverted" : null };
}

/** Explorer link for an EVM entry on a chain the wallet config knows (origin chains for a deposit); null when unknown. */
function explorerFor(entry: JournalEntry): string | null {
  if (!entry.hash || entry.evmChainId === undefined) return null;
  const base = wagmiConfig.chains.find((c) => c.id === entry.evmChainId)?.blockExplorers?.default.url;
  return base ? `${base}/tx/${entry.hash}` : null;
}

function Box({ tone, children }: { tone: "info" | "warn" | "danger" | "safe"; children: ReactNode }) {
  const cls = { info: "border", warn: "border-warn/30 bg-warn/5", danger: "border-danger/30 bg-danger/5", safe: "border-safe/30 bg-safe/5" }[tone];
  return <div role="status" className={`rounded-lg p-3 text-sm ${cls}`}>{children}</div>;
}

export function PendingBanner() {
  const { state, redirect } = useNear();
  const { reviewOpen } = usePolicyContext();
  const queryClient = useQueryClient();
  const account = state.status === "signed-in" ? state.accountId : null;
  const [redirectDismissed, setRedirectDismissed] = useState(false);
  const pending = useQuery({
    queryKey: ["journal", account],
    enabled: account !== null && !reviewOpen,
    queryFn: () => check(account!),
    refetchInterval: 6_000,
  });

  const dismiss = () => {
    if (account) clearJournal(account);
    void queryClient.invalidateQueries({ queryKey: ["journal"] });
  };

  const p = pending.data;
  const walletExplorer = p?.kind === "check-wallet" ? explorerFor(p.entry) : null;
  return (
    <>
      {redirect && !redirectDismissed ? (
        <Box tone={"error" in redirect ? "danger" : "safe"}>
          {"error" in redirect ? (
            <p>Your wallet reported: {redirect.error}</p>
          ) : (
            <p>
              Your wallet reports the transaction was sent.{" "}
              {redirect.hashes.map((h) => (
                <a key={h} className="mr-2 text-primary underline" href={nearTxUrl(h)} target="_blank" rel="noreferrer noopener">
                  View on NearBlocks
                </a>
              ))}
            </p>
          )}
          <Button size="sm" variant="ghost" className="mt-1" onClick={() => { if (account) clearJournal(account); setRedirectDismissed(true); void queryClient.invalidateQueries(); }}>
            Dismiss
          </Button>
        </Box>
      ) : null}
      {p?.kind === "expired" ? <Box tone="info">An unfinished action from more than 24 hours ago was forgotten. Check your wallet history if you are unsure.</Box> : null}
      {p?.kind === "waiting" ? (
        <Box tone="warn">
          <p>
            Waiting for confirmation: {kindLabel(p.entry.kind, p.entry.method)}. Don&apos;t sign it again.{" "}
            <a className="text-primary underline" href={p.url} target="_blank" rel="noreferrer noopener">
              View
            </a>
          </p>
        </Box>
      ) : null}
      {p?.kind === "check-wallet" ? (
        <Box tone="warn">
          <p>
            {kindLabel(p.entry.kind, p.entry.method)} was sent from your wallet; check it there.
            {walletExplorer ? (
              <>
                {" "}
                <a className="text-primary underline" href={walletExplorer} target="_blank" rel="noreferrer noopener">
                  View
                </a>
              </>
            ) : null}
          </p>
          <Button size="sm" variant="outline" className="mt-2" onClick={dismiss}>Dismiss</Button>
        </Box>
      ) : null}
      {p?.kind === "no-hash" ? (
        <Box tone="warn">
          <p>Your wallet never confirmed {kindLabel(p.entry.kind, p.entry.method)}; check its history before retrying.</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={dismiss}>I checked</Button>
        </Box>
      ) : null}
      {p?.kind === "done" ? (
        <Box tone={p.failure ? "danger" : "safe"}>
          <p>
            {p.failure
              ? `${kindLabel(p.entry.kind, p.entry.method)} failed: ${explainContractError(p.failure).message}`
              : `${kindLabel(p.entry.kind, p.entry.method)} confirmed.`}
          </p>
          <Button size="sm" variant="ghost" className="mt-1" onClick={() => void queryClient.invalidateQueries()}>Refresh</Button>
        </Box>
      ) : null}
    </>
  );
}
