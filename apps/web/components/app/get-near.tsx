"use client";

/**
 * "Get NEAR": swap USDC or ETH on Base into the user's OWN NEAR account, without leaving the app.
 * Only mounted when NEXT_PUBLIC_GET_NEAR_ENABLED=1. Non-custodial: the user's wallet sends to a one-time
 * swap address whose signed quote names their NEAR account as recipient and their wallet as refund address.
 * The flow logic lives in lib/get-near.ts (pure, tested); this file only wires it to React.
 */
import { NEAR_TOPUP_DESTINATION, NEAR_TOPUP_LIMITS, NEAR_TOPUP_ORIGINS } from "@backstop/config/near-topup";
import { baseTxUrl } from "@backstop/config/registry";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { useSwitchChain } from "wagmi";
import { ConnectWalletButton } from "@/components/app/connect-steps";
import { useEvmIdentity } from "@/components/app/evm-identity";
import { usePolicyContext } from "@/components/app/policy-context";
import { Button } from "@/components/ui/button";
import { nearText } from "@/lib/create-vault";
import { fetchStatus, TERMINAL } from "@/lib/fund/client";
import type { TopUpQuoteView, TopUpRequest } from "@/lib/fund/near-topup-shared";
import {
  amountInForTarget,
  deriveTopUp,
  durationText,
  estimateUsd,
  parseSavedTopUp,
  PROGRESS,
  progressIndex,
  quoteBlockReason,
  requestOf,
  requestTopUpQuote,
  savedTopUpKey,
  shouldReset,
  swapStatusUrl,
  tokenText,
  topUpTarget,
  usdText,
  verifyTopUpInBrowser,
  withTxHash,
  type SavedTopUp,
} from "@/lib/get-near";
import { prepareTopUpSend, prepareUnwrap, readOriginBalances, readWrappedNear, unwrapGasMessage } from "@/lib/get-near-review";
import { useLocalString } from "@/lib/use-client";
import { cn } from "@/lib/utils";
import { formatUtc } from "@/lib/format";
import { errorText, walletErrorMessage } from "@/lib/wallet-errors";

const origin = NEAR_TOPUP_ORIGINS[0]!;
const POLL_MS = 5_000;
const stamp = () => Date.now();

type Offer = { quote: TopUpQuoteView; req: TopUpRequest; symbol: string; decimals: number; contract: string | null; takenAt: number; epoch: number };

/** Small stepper: dots joined by a line that fills as the swap moves on. `working`: the current step is waiting on the network. */
/** A value with a Copy button (for sending by hand from any wallet). */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-muted-foreground">{label}</span>
      <code className="min-w-0 break-all font-mono text-foreground">{value}</code>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2"
        onClick={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false))}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function Progress({ at, working }: { at: number; working: boolean }) {
  const last = PROGRESS.length - 1;
  return (
    <ol className="flex items-center text-xs" aria-label="Progress">
      {PROGRESS.map((label, i) => {
        const done = i < at || at === last;
        const current = i === at && !done;
        return (
          <li key={label} aria-current={current ? "step" : undefined} className={cn("flex items-center", i < last && "flex-1")}>
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.625rem] font-semibold transition-colors duration-300",
                done && "border-primary bg-primary text-primary-foreground",
                current && "dot-halo border-primary bg-primary/15 text-primary",
                !done && !current && "border-border text-muted-foreground",
              )}
            >
              {done ? <Check key="done" className="check-pop size-3" aria-hidden /> : current && working ? <Loader2 className="size-3 animate-spin" aria-hidden /> : i + 1}
            </span>
            <span className={cn("ml-1.5 transition-colors duration-300", current ? "font-medium" : done ? "hidden text-foreground/80 sm:inline" : "hidden text-muted-foreground sm:inline")}>{label}</span>
            {i < last ? (
              <span className="mx-2 h-0.5 min-w-3 flex-1 overflow-hidden rounded-full bg-border" aria-hidden>
                <span className={cn("block h-full origin-left bg-primary transition-transform duration-500 ease-out motion-reduce:transition-none", i < at ? "scale-x-100" : "scale-x-0")} />
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function SupportDetails({ saved, open }: { saved: SavedTopUp; open: boolean }) {
  const address = saved.quote.depositAddress!;
  return (
    <details open={open} className="rounded-md border bg-muted/40 p-3 text-xs">
      <summary className="cursor-pointer font-medium">Details for support</summary>
      <dl className="mt-2 space-y-1 break-all">
        <div><dt className="inline text-muted-foreground">Swap address: </dt><dd className="inline font-mono">{address}</dd></div>
        {saved.txHash ? (
          <div>
            <dt className="inline text-muted-foreground">Your {origin.name} transaction: </dt>
            <dd className="inline"><a className="font-mono text-primary underline" href={baseTxUrl(saved.txHash)} target="_blank" rel="noreferrer noopener">{saved.txHash}</a></dd>
          </div>
        ) : null}
        <div><dt className="inline text-muted-foreground">Sent to NEAR account: </dt><dd className="inline font-mono">{saved.account}</dd></div>
        <div><dt className="inline text-muted-foreground">Refunds go to: </dt><dd className="inline font-mono">{saved.quote.refundTo}</dd></div>
        <div>
          <a className="text-primary underline" href={swapStatusUrl(address)} target="_blank" rel="noreferrer noopener">Swap status page</a>
        </div>
      </dl>
    </details>
  );
}

/** `needYocto`: NEAR the account must hold to create a vault (deposit + wallet gas). `nativeYocto`: its NEAR now (null until read). */
export function GetNear({ accountId, needYocto, nativeYocto, bare = false }: { accountId: string; needYocto: bigint; nativeYocto: bigint | null; /** Inside the create card's "Pay with" tabs: no own frame or heading. */ bare?: boolean }) {
  const queryClient = useQueryClient();
  const { identity, epoch } = useEvmIdentity();
  const { openReview, reviewOpen } = usePolicyContext();
  const { mutate: switchChain, isPending: switching } = useSwitchChain();
  const key = savedTopUpKey(accountId);
  const [raw, setRaw] = useLocalString(key);
  const [now, setNow] = useState(stamp);
  const saved = parseSavedTopUp(raw, accountId, now);
  const [assetId, setAssetId] = useState<string>(origin.assets[0]!.assetId);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which part of getting a quote is running, shown on the button. */
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const epochRef = useRef(epoch);
  useEffect(() => {
    epochRef.current = epoch;
  }, [epoch]);

  useEffect(() => {
    const t = setInterval(() => setNow(stamp()), 1_000);
    return () => clearInterval(t);
  }, []);

  const evmAddress = identity.mode === "wallet" ? identity.address : null;
  const depositAddress = saved?.quote.depositAddress ?? null;

  const status = useQuery({
    queryKey: ["fund-status", depositAddress],
    enabled: depositAddress !== null,
    queryFn: () => fetchStatus(depositAddress!),
    refetchInterval: (q) => (q.state.data && (TERMINAL as readonly string[]).includes(q.state.data.status) ? false : POLL_MS),
  });
  const statusValue = status.data?.status ?? null;

  const wrapped = useQuery({
    queryKey: ["wnear", accountId],
    enabled: saved !== null && statusValue === "SUCCESS" && NEAR_TOPUP_DESTINATION.delivery === "wrapped",
    queryFn: () => readWrappedNear(accountId),
    refetchInterval: POLL_MS,
  });

  const balances = useQuery({
    queryKey: ["topup-balances", origin.key, evmAddress],
    // Also read while an old, finished swap is remembered: the card then offers a new quote.
    enabled: evmAddress !== null,
    queryFn: () => readOriginBalances(origin, evmAddress!),
    staleTime: 15_000,
  });

  const view = deriveTopUp({
    saved,
    status: statusValue,
    statusAmountOut: status.data?.amountOut,
    nativeYocto,
    wrappedYocto: wrapped.data ?? null,
    needYocto,
    nowMs: now,
  });

  // While a swap is on its way, read the account's NEAR every few seconds (the create card shares this query).
  const watching = view.kind === "swapping" || view.kind === "unwrap" || view.kind === "short";
  useEffect(() => {
    if (!watching) return;
    const t = setInterval(() => void queryClient.invalidateQueries({ queryKey: ["near-account", accountId] }), POLL_MS);
    return () => clearInterval(t);
  }, [watching, queryClient, accountId]);

  // The connected wallet changed account before anything was sent: that quote refunds to the old wallet, so it is not offered any more.
  const walletChanged = saved !== null && shouldReset(saved, evmAddress, statusValue);
  // A quote on screen (not yet confirmed) belongs to the wallet account and network it was asked with.
  const liveOffer = offer && offer.epoch === epoch ? offer : null;

  // Re-check a remembered quote after a reload, as of when it was taken.
  const recheck = useQuery({
    queryKey: ["topup-verify", saved?.quote.depositAddress, saved?.quote.signature],
    enabled: saved !== null,
    staleTime: Infinity,
    queryFn: () => verifyTopUpInBrowser(saved!.quote, requestOf(saved!), needYocto, saved!.createdAt),
  });

  if (view.kind === "hidden") return null;

  const short = topUpTarget(needYocto, nativeYocto);
  const wrongNetwork = identity.mode === "wallet" && identity.chainId !== origin.evmChainId;
  const switchButton = (
    <Button
      disabled={switching}
      onClick={() => switchChain({ chainId: origin.evmChainId as 8453 }, { onError: (e) => setError(walletErrorMessage(e, "Your wallet would not switch", "the switch button again").message) })}
    >
      {switching ? "Check your wallet..." : `Switch to ${origin.name}`}
    </Button>
  );
  const startOver = () => {
    setRaw(null);
    setOffer(null);
    setError(null);
  };

  async function getQuote() {
    setError(null);
    if (!evmAddress || !short || short.targetYocto === 0n) return;
    const asset = origin.assets.find((a) => a.assetId === assetId) ?? origin.assets[0]!;
    const startedEpoch = epochRef.current;
    setBusy(true);
    try {
      const base = { originChain: origin.key, originAsset: asset.assetId, recipient: accountId, refundTo: evmAddress };
      setPhase("Checking the price...");
      const probe = await requestTopUpQuote({ ...base, amount: asset.probeAmount, dry: true });
      const probeNums = { amountIn: BigInt(probe.amountIn), amountOut: BigInt(probe.amountOut), amountInUsd: probe.amountInUsd };
      const amountIn = amountInForTarget(short.targetYocto, probeNums);
      const usd = estimateUsd(amountIn, probeNums);
      if (usd > NEAR_TOPUP_LIMITS.maxUsd) {
        throw new Error(`This needs about ${usdText(usd)}, above the ${usdText(NEAR_TOPUP_LIMITS.maxUsd)} limit for one swap. Send NEAR from an exchange instead.`);
      }
      const held = balances.data?.[asset.assetId];
      if (held !== undefined && (asset.contract ? held < amountIn : held <= amountIn)) {
        throw new Error(`This needs about ${tokenText(amountIn, asset.decimals, asset.symbol)}${asset.contract ? "" : " plus network fees"}; your wallet holds ${tokenText(held, asset.decimals, asset.symbol)} on ${origin.name}. Pick the other token or add funds.`);
      }
      const req: TopUpRequest = { ...base, amount: amountIn.toString() };
      setPhase("Getting your quote...");
      const quote = await requestTopUpQuote(req);
      const takenAt = stamp();
      setPhase("Checking the signed quote...");
      const check = await verifyTopUpInBrowser(quote, req, needYocto, takenAt);
      if (!check.ok) throw new Error(check.reason);
      if (BigInt(quote.minAmountOut) < short.shortYocto) {
        throw new Error("The rate moved while quoting, and the minimum you would receive no longer covers what you need. Get a new quote.");
      }
      if (epochRef.current !== startedEpoch) {
        throw new Error("Your wallet changed account or network while the quote was loading. Nothing was sent. Get a new quote.");
      }
      setOffer({ quote, req, symbol: asset.symbol, decimals: asset.decimals, contract: asset.contract, takenAt, epoch: startedEpoch });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      setPhase(null);
    }
  }

  function send(record: SavedTopUp) {
    if (identity.mode !== "wallet") return;
    openReview({
      kind: "get_near",
      prepare: () =>
        prepareTopUpSend(
          { address: identity.address, chainId: identity.chainId },
          { origin, symbol: record.symbol, decimals: record.decimals, contract: record.contract, depositAddress: record.quote.depositAddress!, amount: BigInt(record.quote.amountIn), deadline: record.quote.deadline!, recipient: accountId },
        ),
      onSubmitted: (hash) => {
        // Read the latest record (not this closure's) so a newer state is never overwritten.
        let latest: SavedTopUp | null = null;
        try {
          latest = parseSavedTopUp(localStorage.getItem(key), accountId, stamp());
        } catch {
          latest = null;
        }
        if (latest && latest.quote.depositAddress === record.quote.depositAddress) setRaw(JSON.stringify(withTxHash(latest, hash, stamp())));
      },
    });
  }

  function confirm() {
    const offer = liveOffer;
    // Never fail silently: say why nothing happened.
    if (!offer) return setError("This quote is no longer valid (your wallet changed). Get a new quote.");
    if (!evmAddress) return setError("Connect MetaMask or Rabby, then press Confirm and send again.");
    if (nativeYocto === null) return setError("Still reading your NEAR balance. Try again in a second.");
    if (offer.quote.deadline && Date.parse(offer.quote.deadline) <= stamp()) {
      setOffer(null);
      setError("That quote expired. Get a new one.");
      return;
    }
    const record: SavedTopUp = {
      v: 1,
      account: accountId,
      evmAddress,
      symbol: offer.symbol,
      decimals: offer.decimals,
      contract: offer.contract,
      quote: offer.quote,
      startNative: nativeYocto.toString(),
      createdAt: offer.takenAt,
    };
    // Remembered before the wallet opens, so a reload mid-swap resumes from the swap address.
    setRaw(JSON.stringify(record));
    setOffer(null);
    send(record);
  }

  const honest = (
    <p className="text-xs text-muted-foreground">
      This is a swap, not a transfer: the rate includes a spread and a small fee, so the NEAR you get can be a little less than the estimate (never less
      than the minimum shown). Your vault deposit is held in NEAR and comes back to you in NEAR, not USDC, when you close the vault.
    </p>
  );

  const body = (() => {
    switch (view.kind) {
      case "quote": {
        const block = quoteBlockReason({ nativeYocto, accountId });
        if (block) return <p className="text-sm text-muted-foreground">{block}</p>;
        if (identity.mode !== "wallet") {
          return (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Connect the wallet that holds USDC or ETH on {origin.name}. You swap just enough of it into NEAR, sent straight to your own account, {accountId}.
              </p>
              <ConnectWalletButton label="Connect MetaMask or Rabby" />
            </div>
          );
        }
        if (liveOffer) {
          const offer = liveOffer;
          const q = offer.quote;
          return (
            <div className="step-in space-y-3">
              <dl className="divide-y rounded-lg border text-sm">
                {[
                  ["You send", `${tokenText(BigInt(q.amountIn), offer.decimals, offer.symbol, 8)} on ${origin.name} (about ${usdText(q.amountInUsd)})`],
                  ["You receive about", `${nearText(BigInt(q.amountOut), 4)}${q.amountOutUsd !== null ? ` (about ${usdText(q.amountOutUsd)})` : ""}`],
                  ["You receive at least", nearText(BigInt(q.minAmountOut), 4)],
                  ["Spread and fees", q.amountOutUsd !== null ? `about ${usdText(Math.max(0, q.amountInUsd - q.amountOutUsd))}${q.extraFee ? " (includes a 0.25% service fee)" : ""}` : "included in the rate"],
                  ["Arrives in", `${accountId}, ${durationText(q.timeEstimate)} after your deposit confirms`],
                  ...(NEAR_TOPUP_DESTINATION.delivery === "wrapped" ? [["Arrives as", "wrapped NEAR; one more approval turns it into NEAR"]] : []),
                  ...((): string[][] => {
                    // Show that only the shortfall is swapped: what stays in the wallet after this send.
                    const held = balances.data?.[q.originAsset];
                    if (held === undefined) return [];
                    const left = held - BigInt(q.amountIn);
                    return left >= 0n ? [["Stays in your wallet", `${tokenText(left, offer.decimals, offer.symbol, 4)}${offer.contract ? "" : " (minus network fees)"}`]] : [];
                  })(),
                  ["If the swap cannot finish", `your ${offer.symbol} goes back to ${q.refundTo} on ${origin.name}`],
                ].map(([label, value]) => (
                  <div key={label} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:justify-between sm:gap-4">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="min-w-0 break-all sm:text-right">{value}</dd>
                  </div>
                ))}
              </dl>
              {honest}
              <div className="flex flex-wrap gap-2">
                <Button onClick={confirm} disabled={reviewOpen}>Confirm and send</Button>
                <Button variant="ghost" onClick={() => setOffer(null)}>Cancel</Button>
              </div>
            </div>
          );
        }
        return (
          <div className="space-y-3">
            {offer && !liveOffer ? (
              <p role="status" className="text-sm text-warn">
                Your wallet changed account or network, so that quote was dropped. Nothing was sent.
              </p>
            ) : null}
            {short && short.shortYocto > 0n ? (
              <p className="text-sm">
                You need about <strong>{nearText(short.shortYocto, 3)}</strong> more. We swap only that much (plus 5% for the spread), about{" "}
                {nearText(short.targetYocto, 3)}. The rest of your wallet is not touched.
              </p>
            ) : null}
            <div role="radiogroup" aria-label="Pay with" className="grid gap-2 sm:grid-cols-2">
              {origin.assets.map((a) => {
                const held = balances.data?.[a.assetId];
                return (
                  <label key={a.assetId} className="flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm has-[:checked]:border-primary">
                    <input type="radio" name="get-near-asset" checked={assetId === a.assetId} onChange={() => setAssetId(a.assetId)} />
                    <span className="font-medium">{a.symbol} on {origin.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{held === undefined ? (balances.isPending ? "..." : "") : `you have ${tokenText(held, a.decimals, a.symbol, 4)}`}</span>
                  </label>
                );
              })}
            </div>
            {wrongNetwork ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Your wallet is on another network. Switch it to {origin.name} first.</p>
                {switchButton}
              </div>
            ) : (
              <div className="space-y-2">
                <Button onClick={() => void getQuote()} disabled={busy || reviewOpen}>
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  {busy ? (phase ?? "Getting a quote...") : "Get a quote"}
                </Button>
                <p className="text-xs text-muted-foreground">Nothing is sent yet: you see the exact amounts first, then approve in your wallet.</p>
              </div>
            )}
          </div>
        );
      }
      case "send": {
        const s = saved!;
        if (recheck.isPending) return <p className="text-sm text-muted-foreground">Checking the quote...</p>;
        if (recheck.data && !recheck.data.ok) {
          return (
            <div role="alert" className="space-y-2 text-sm text-danger">
              <p className="font-medium">Do not send funds to this address.</p>
              <p>{recheck.data.reason}</p>
              <Button size="sm" variant="outline" onClick={startOver}>Discard</Button>
            </div>
          );
        }
        const remaining = Math.max(0, Math.floor((Date.parse(s.quote.deadline!) - now) / 1000));
        return (
          <div className="space-y-3 text-sm">
            <p>
              Send {tokenText(BigInt(s.quote.amountIn), s.decimals, s.symbol, 8)} on {origin.name} from your wallet. You receive at least {nearText(BigInt(s.quote.minAmountOut), 4)} in {accountId}.
            </p>
            <p className="text-xs text-muted-foreground">This quote is valid for {remaining >= 3600 ? `${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m` : `${Math.floor(remaining / 60)}m ${remaining % 60}s`} (until {formatUtc(s.quote.deadline!)}).</p>
            {identity.mode !== "wallet" ? (
              <ConnectWalletButton label="Connect MetaMask or Rabby" />
            ) : wrongNetwork ? (
              switchButton
            ) : (
              <Button onClick={() => send(s)} disabled={reviewOpen}>Send with wallet</Button>
            )}
            {/* The same deposit by hand, from any wallet: this card watches the address and continues when it arrives. */}
            <details className="rounded-md bg-muted/50 px-3 py-2">
              <summary className="cursor-pointer font-medium">Or send it yourself from MetaMask or Rabby</summary>
              <div className="mt-2 space-y-1.5 text-xs">
                <p className="text-muted-foreground">
                  In your wallet, on <strong className="text-foreground">{origin.name}</strong>, send exactly this amount of {s.symbol} to this address. No other token, no other network. This card moves on by itself when it arrives.
                </p>
                <CopyRow label="Amount" value={`${formatUnits(BigInt(s.quote.amountIn), s.decimals)} ${s.symbol}`} />
                <CopyRow label="To" value={s.quote.depositAddress!} />
              </div>
            </details>
            <Button size="sm" variant="ghost" onClick={startOver}>Discard this quote (only if you have not sent anything)</Button>
          </div>
        );
      }
      case "expired":
        return (
          <div className="space-y-2 text-sm">
            <p>This quote expired before anything was sent. Get a new one.</p>
            <Button size="sm" onClick={startOver}>Get a new quote</Button>
          </div>
        );
      case "swapping":
        return (
          <div className="step-in space-y-2 text-sm" aria-live="polite">
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="flex items-center gap-2 font-medium">
                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                {view.delivered ? "The swap finished. Waiting for the NEAR to show in your account..." : statusValue === null || statusValue === "PENDING_DEPOSIT" ? "Waiting for your deposit to confirm..." : "Swapping into NEAR..."}
              </p>
              <div className="shimmer mt-2 h-1 rounded-full bg-border" aria-hidden />
              <p className="mt-2 text-xs text-muted-foreground">
                {view.delivered ? "Almost done." : statusValue === null || statusValue === "PENDING_DEPOSIT" ? `Step 1 of 2: your ${origin.name} transaction is confirming.` : "Step 2 of 2: the swap is running. This usually takes under a minute."} Nothing to do: this updates on its own, and you can leave and come back.
              </p>
            </div>
            {status.isError ? <p className="text-xs text-warn">Could not read the swap status ({errorText(status.error)}). Retrying.</p> : null}
            {view.stuck ? (
              <p role="alert" className="text-warn">
                This is taking longer than expected. Your funds are either on their way or will be returned to your wallet on {origin.name}. If nothing changes, contact support with the details below.
              </p>
            ) : null}
            <SupportDetails saved={saved!} open={view.stuck} />
          </div>
        );
      case "unwrap":
        return (
          <div className="space-y-2 text-sm">
            <p>{nearText(view.amount, 4)} arrived as wrapped NEAR. One approval turns it into NEAR you can use.</p>
            {view.canPayGas ? (
              <Button
                disabled={reviewOpen}
                onClick={() =>
                  openReview({
                    kind: "unwrap_near",
                    prepare: () => prepareUnwrap(accountId, view.amount),
                    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["wnear", accountId] }),
                  })
                }
              >
                Unwrap {nearText(view.amount, 4)}
              </Button>
            ) : (
              <p role="alert" className="text-warn">{unwrapGasMessage(accountId)}</p>
            )}
            <SupportDetails saved={saved!} open={false} />
          </div>
        );
      case "short":
        return (
          <div className="space-y-2 text-sm">
            <p>NEAR arrived, but your account still needs about {short ? nearText(short.shortYocto, 3) : "a little"} more to open a vault.</p>
            <Button size="sm" onClick={startOver}>Get a little more</Button>
            <SupportDetails saved={saved!} open={view.stuck} />
          </div>
        );
      case "arrived":
        return (
          <div role="status" className="step-in space-y-3 rounded-lg border border-safe/40 bg-safe-bg p-4 text-sm">
            <div className="flex items-start gap-3">
              <span className="check-pop flex size-8 shrink-0 items-center justify-center rounded-full bg-safe text-background">
                <Check className="size-5" aria-hidden />
              </span>
              <div className="min-w-0 space-y-0.5">
                <p className="font-semibold">Your NEAR arrived</p>
                <p className="text-muted-foreground">Your account now has {nativeYocto !== null ? nearText(nativeYocto, 3) : "enough"}. The deposit is covered.</p>
              </div>
            </div>
            <p className="font-medium">Now press Create vault.</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const button = document.getElementById("create-vault-button");
                button?.scrollIntoView({ block: "center" });
                button?.focus({ preventScroll: true });
              }}
            >
              Go to Create vault
            </Button>
          </div>
        );
      case "refunded":
        return (
          <div role="alert" className="space-y-2 text-sm">
            <p className="font-medium">The swap could not finish. Your funds were returned on {origin.name} to {saved!.quote.refundTo}.</p>
            {status.data?.refundReason ? <p className="text-muted-foreground">Reason: {status.data.refundReason}</p> : null}
            <Button size="sm" onClick={startOver}>Start over</Button>
            <SupportDetails saved={saved!} open={false} />
          </div>
        );
      case "incomplete":
      case "failed":
        return (
          <div role="alert" className="space-y-2 text-sm">
            <p className="font-medium">
              {view.kind === "incomplete"
                ? "The amount that arrived was less than the quote needs, so the swap did not run. It is returned to your wallet on Base."
                : "The swap failed and no NEAR was delivered. If you sent funds, they go back to your wallet on Base."}
            </p>
            <p className="text-muted-foreground">If they do not come back, contact support with the details below.</p>
            <Button size="sm" onClick={startOver}>Start over</Button>
            <SupportDetails saved={saved!} open />
          </div>
        );
    }
  })();

  return (
    <section aria-label="Get NEAR" className={bare ? "space-y-3 break-words" : "space-y-3 break-words rounded-lg border border-primary/30 bg-primary/5 p-4"}>
      {bare ? null : (
        <div className="space-y-1">
          <p className="text-base font-semibold">Get NEAR</p>
          <p className="text-sm text-muted-foreground">Swap USDC or ETH on {origin.name} into NEAR for your own account, {accountId}. Nobody else holds it on the way.</p>
        </div>
      )}
      <Progress at={progressIndex(view)} working={busy || view.kind === "swapping"} />
      {walletChanged ? (
        <div role="status" className="space-y-2 text-sm">
          <p>Your wallet account changed, so this quote was cancelled: its refunds would go to the previous account. Nothing was sent.</p>
          <Button size="sm" onClick={startOver}>Get a new quote</Button>
        </div>
      ) : (
        body
      )}
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    </section>
  );
}
