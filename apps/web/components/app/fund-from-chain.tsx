"use client";

/** Fund the vault from any chain through a 1Click deposit address (E.9, D20, D21). */
import { nearTxUrl } from "@backstop/config/registry";
import { formatUsdc } from "@backstop/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import qrcode from "qrcode-generator";
import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useSwitchChain } from "wagmi";
import { useEvmIdentity } from "@/components/app/evm-identity";
import { ConnectWalletButton } from "@/components/app/connect-steps";
import { usePolicyContext } from "@/components/app/policy-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { chainsOf, fetchOriginTokens, fetchStatus, isPreferred, parseSaved, requestQuote, TERMINAL, tokensOn, verifyQuoteInBrowser, type SavedFund, type StatusView } from "@/lib/fund/client";
import { chainName, EVM_CHAINS, type OriginToken } from "@/lib/fund/shared";
import { prepareFundSend } from "@/lib/review";
import { useLocalString } from "@/lib/use-client";
import { parseDecimal } from "@/lib/validate";
import { errorText, walletErrorMessage } from "@/lib/wallet-errors";

const stamp = () => Date.now();
const field = "h-10 w-full rounded-md border bg-background px-3 text-sm";

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function Qr({ value }: { value: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [value]);
  // The SVG is generated locally from `value` by qrcode-generator (only <rect>/<path> shapes); the value itself is not embedded as markup.
  return <div className="size-40 shrink-0 rounded bg-white p-1 [&>svg]:size-full" role="img" aria-label="QR code of the deposit address" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const STATUS_TEXT: Record<StatusView["status"], { label: string; tone: "warn" | "safe" | "danger" | "default"; next: string }> = {
  PENDING_DEPOSIT: { label: "Waiting for your deposit", tone: "warn", next: "Send the exact amount to the address above before the deadline." },
  KNOWN_DEPOSIT_TX: { label: "Deposit seen", tone: "default", next: "Confirming it." },
  PROCESSING: { label: "Converting and delivering", tone: "default", next: "Usually under a few minutes. You can leave this page; it resumes when you return." },
  SUCCESS: { label: "Delivered to your vault", tone: "safe", next: "The USDC is in your vault now." },
  REFUNDED: { label: "Refunded", tone: "danger", next: "The swap could not complete; your funds went back to the refund address on the origin chain." },
  FAILED: { label: "Failed", tone: "danger", next: "Nothing was delivered. If you sent funds, check the refund address on the origin chain and contact support with the deposit address." },
  INCOMPLETE_DEPOSIT: { label: "Deposit was too small", tone: "danger", next: "The amount that arrived was below what the quote needs. It is refunded or can be topped up before the deadline." },
};

function StatusPanel({ saved, onDone }: { saved: SavedFund; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { snap } = usePolicyContext();
  const status = useQuery({
    queryKey: ["fund-status", saved.quote.depositAddress],
    queryFn: () => fetchStatus(saved.quote.depositAddress),
    refetchInterval: (q) => (q.state.data && (TERMINAL as readonly string[]).includes(q.state.data.status) ? false : 5_000),
  });
  const s = status.data?.status;
  useEffect(() => {
    if (s === "SUCCESS") void queryClient.invalidateQueries();
  }, [s, queryClient]);
  const info = s ? STATUS_TEXT[s] : null;
  const nearTxs = [...(status.data?.nearTxHashes ?? [])];
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Status</span>
        {info ? <Badge variant={info.tone}>{info.label}</Badge> : <Badge variant="outline">{status.isError ? "unavailable" : "checking..."}</Badge>}
      </div>
      {info ? <p className="text-muted-foreground">{info.next}</p> : null}
      {status.isError ? <p className="text-warn">Could not reach the status service ({errorText(status.error)}). Retrying every 5 seconds.</p> : null}
      {s === "REFUNDED" && status.data?.refundReason ? <p className="text-muted-foreground">Reason: {status.data.refundReason}</p> : null}
      {nearTxs.map((h) => (
        <p key={h}>
          <a className="text-primary underline" href={nearTxUrl(h)} target="_blank" rel="noreferrer noopener">NEAR transaction</a>
        </p>
      ))}
      {s === "SUCCESS" ? <p>Vault balance now: <strong>{snap ? formatUsdc(snap.usdcBalance) : "..."} USDC</strong></p> : null}
      {s && (TERMINAL as readonly string[]).includes(s) ? (
        <Button size="sm" variant="outline" onClick={onDone}>Start another deposit</Button>
      ) : null}
    </div>
  );
}

function Instructions({ saved, onReset }: { saved: SavedFund; onReset: () => void }) {
  const q = saved.quote;
  const now = useNow(1000);
  const { identity } = useEvmIdentity();
  const { openReview, policyId, reviewOpen } = usePolicyContext();
  const { mutate: switchChain, isPending: switching } = useSwitchChain();
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const check = useQuery({ queryKey: ["fund-verify", q.depositAddress, q.signature], queryFn: () => verifyQuoteInBrowser(q), staleTime: Infinity });

  const remaining = Math.max(0, Math.floor((Date.parse(q.deadline) - now) / 1000));
  const expired = remaining === 0;
  const evmChainId = EVM_CHAINS[saved.chain];
  const amount = BigInt(q.amountIn);
  const human = `${formatUnits(amount, saved.decimals)} ${saved.symbol}`;

  if (check.isPending) return <p className="text-sm text-muted-foreground">Checking the quote...</p>;
  if (check.data && !check.data.ok) {
    return (
      <div role="alert" className="space-y-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
        <p className="font-medium">Do not send funds to this address.</p>
        <p>{check.data.reason}</p>
        <Button size="sm" variant="outline" onClick={onReset}>Discard</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row">
        <Qr value={q.depositAddress} />
        <div className="min-w-0 flex-1 space-y-2 text-sm">
          <p className="font-medium">Send exactly {human} on {chainName(saved.chain)} to:</p>
          <p className="break-all rounded-md border bg-muted p-2 font-mono text-xs" data-testid="deposit-address">{q.depositAddress}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(q.depositAddress).then(() => setCopied(true));
            }}
          >
            <Copy /> {copied ? "Copied" : "Copy address"}
          </Button>
          {q.depositMemo ? (
            <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-2 font-medium text-danger">
              Memo / tag REQUIRED: <span className="break-all font-mono">{q.depositMemo}</span>. Without it your deposit cannot be matched.
            </p>
          ) : null}
        </div>
      </div>
      <dl className="divide-y rounded-lg border text-sm">
        {[
          ["Arrives in your vault", `at least ${formatUsdc(BigInt(q.minAmountOut))} USDC on NEAR (about ${q.amountOutFormatted || "?"})`],
          ["Estimated time", `about ${q.timeEstimate} seconds after the deposit confirms`],
          ["Deposit address valid for", expired ? "expired" : `${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m ${remaining % 60}s`],
          ["If something goes wrong, refund to", q.refundTo],
          ["Vault", q.policy],
        ].map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:justify-between sm:gap-4">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-all sm:text-right">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        Sending a different token, another chain, or sending after the deadline may lose funds or trigger a refund.
        {q.extraFee ? " The swap service adds a 0.25% fee." : ""}
        {check.data?.ok && check.data.signature === "unsupported" ? " This browser cannot check the quote's signature itself; the server did." : ""}
      </p>
      {expired ? <p role="alert" className="text-sm text-danger">This address has expired. Do not send to it; start a new deposit.</p> : null}

      {evmChainId !== undefined && !expired ? (
        <div className="space-y-2">
          {identity.mode !== "wallet" ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-muted-foreground">Connect a wallet to send from here, or send from any wallet to the address above.</p>
              <ConnectWalletButton />
            </div>
          ) : identity.chainId !== evmChainId ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Your wallet is on {identity.chainName ?? `chain ${identity.chainId ?? "unknown"}`}; this deposit is sent on {chainName(saved.chain)}.
              </p>
              <Button
                disabled={switching}
                onClick={() => {
                  setSwitchError(null);
                  switchChain({ chainId: evmChainId as 1 }, { onError: (e) => setSwitchError(walletErrorMessage(e, "Your wallet would not switch", "the switch button again").message) });
                }}
              >
                {switching ? "Check your wallet..." : `Switch to ${chainName(saved.chain)} to send`}
              </Button>
            </div>
          ) : (
            <Button
              disabled={reviewOpen}
              onClick={() =>
                openReview({
                  kind: "fund_from_chain",
                  prepare: () =>
                    prepareFundSend(
                      { address: identity.address, chainId: identity.chainId },
                      { chainId: evmChainId, chainName: chainName(saved.chain), symbol: saved.symbol, decimals: saved.decimals, contract: saved.contract, depositAddress: q.depositAddress, amount, deadline: q.deadline, policyId: policyId ?? q.policy },
                    ),
                })
              }
            >
              Send with wallet
            </Button>
          )}
          {switchError ? <p className="text-sm text-muted-foreground">{switchError}</p> : null}
        </div>
      ) : null}

      <StatusPanel saved={saved} onDone={onReset} />
      {!expired ? (
        <Button size="sm" variant="ghost" onClick={onReset}>Discard this address (only if you have not sent anything)</Button>
      ) : null}
    </div>
  );
}

export function FundFromChain() {
  const { policyId, owner } = usePolicyContext();
  const { identity } = useEvmIdentity();
  const [rawSaved, setRawSaved] = useLocalString(policyId ? `backstop.fund.${policyId}` : null);
  const saved = parseSaved(rawSaved);
  const tokens = useQuery({ queryKey: ["origin-tokens"], queryFn: fetchOriginTokens, staleTime: 10 * 60_000 });

  const [chain, setChain] = useState("base");
  const [assetId, setAssetId] = useState<string | null>(null);
  const [amountText, setAmountText] = useState("");
  const [refundEdit, setRefundEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!policyId || !owner) return null;
  if (saved) return <Instructions saved={saved} onReset={() => setRawSaved(null)} />;

  const list: OriginToken[] = tokens.data ?? [];
  const chains = chainsOf(list);
  const options = tokensOn(list, chain);
  const token = options.find((t) => t.assetId === assetId) ?? options[0];
  const isEvm = EVM_CHAINS[chain] !== undefined;
  const refund = refundEdit ?? (isEvm && identity.mode === "wallet" ? identity.address : "");

  async function submit() {
    setError(null);
    if (!token) return setError("Pick a token.");
    const amount = parseDecimal(amountText, token.decimals, "The amount");
    if (!amount.ok) return setError(amount.error);
    if (!refund.trim()) return setError(`Enter a refund address on ${chainName(chain)}: where your funds go back if the swap cannot complete.`);
    setBusy(true);
    try {
      const quote = await requestQuote({ policy: policyId!, originAsset: token.assetId, amount: amount.value.toString(), refundTo: refund.trim() });
      const record: SavedFund = { quote, symbol: token.symbol, chain: token.blockchain, decimals: token.decimals, contract: token.contractAddress ?? null, createdAt: stamp() };
      setRawSaved(JSON.stringify(record));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Pay from any chain, wallet or exchange. It is converted to USDC and delivered to your vault. You get a one-time deposit address; send only the token and amount shown.
      </p>
      {tokens.isPending ? <p className="text-sm text-muted-foreground">Loading supported tokens...</p> : null}
      {tokens.isError ? <p role="alert" className="text-sm text-danger">Could not load the token list ({errorText(tokens.error)}). Reload to retry.</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">From chain</span>
          <select className={field} value={chain} onChange={(e) => { setChain(e.target.value); setAssetId(null); setRefundEdit(null); }}>
            {chains.map((c) => (
              <option key={c} value={c}>{chainName(c)}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Token</span>
          <select className={field} value={token?.assetId ?? ""} onChange={(e) => setAssetId(e.target.value)}>
            {options.map((t) => (
              <option key={t.assetId} value={t.assetId}>{t.symbol}{isPreferred(t) ? " (stablecoin)" : ""}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Amount{token ? ` (${token.symbol})` : ""}</span>
          <input className={field} inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="10" autoComplete="off" />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Refund address on {chainName(chain)}</span>
          <input className={`${field} font-mono`} value={refund} onChange={(e) => setRefundEdit(e.target.value)} placeholder={isEvm ? "0x..." : "your address"} spellCheck={false} autoComplete="off" />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Use an address you control on {chainName(chain)}, not an exchange deposit address. If the swap cannot complete, your funds go back there.
      </p>
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      <Button type="submit" disabled={busy || !token}>{busy ? "Requesting a deposit address..." : "Get deposit address"}</Button>
    </form>
  );
}
