/**
 * "Get NEAR" flow logic, kept out of React so it is testable without a browser: how much NEAR to ask for, how
 * much to send for it, what the 1Click status means for the user, what is remembered across a reload, and
 * which step the card shows. Browser-safe; the only network calls are the two small fetchers at the bottom.
 */
import { NEAR_TOPUP_DESTINATION, NEAR_TOPUP_LIMITS, type NearDelivery } from "@backstop/config/near-topup";
import { ONE_CLICK } from "@backstop/config/registry";
import { formatUnits } from "viem";
import { z } from "zod";
import { verifySignatureInBrowser, type BrowserCheck, type StatusView } from "@/lib/fund/client";
import { checkTopUpQuote, limitsFor, topUpQuoteViewSchema, type TopUpQuoteView, type TopUpRequest } from "@/lib/fund/near-topup-shared";
import { PUBLIC_ENV } from "@/lib/public-env";

/** The card exists only with NEXT_PUBLIC_GET_NEAR_ENABLED=1. */
export const getNearEnabled = (env: { getNearEnabled: boolean } = PUBLIC_ENV): boolean => env.getNearEnabled;

/** After this long since sending without the NEAR arriving, show the support details. */
export const STUCK_MS = 30 * 60_000;
/** Remembered swaps older than this are dropped. */
export const SAVED_MAX_AGE_MS = 7 * 24 * 3_600_000;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * What the account is missing for `needYocto` and what to ask the swap for: the shortfall plus 5% for the
 * spread. Both 0 when the account already has enough. `haveYocto` null (not read yet) = nothing decided.
 */
export function topUpTarget(needYocto: bigint, haveYocto: bigint | null): { shortYocto: bigint; targetYocto: bigint } | null {
  if (haveYocto === null) return null;
  if (haveYocto >= needYocto) return { shortYocto: 0n, targetYocto: 0n };
  const shortYocto = needYocto - haveYocto;
  return { shortYocto, targetYocto: ceilDiv(shortYocto * (10_000n + BigInt(NEAR_TOPUP_LIMITS.clientBufferBps)), 10_000n) };
}

export type Probe = { amountIn: bigint; amountOut: bigint; amountInUsd: number };

const usdMicros = (n: number) => BigInt(Math.round(n * 1e6));

/**
 * Origin amount (smallest unit) to send for about `targetYocto`, scaled from a price-check quote (no hardcoded
 * price). Rounded up to the minimum (+2%) the swap accepts. Throws when the probe is unusable.
 */
export function amountInForTarget(targetYocto: bigint, probe: Probe, minUsd: number = NEAR_TOPUP_LIMITS.minUsd): bigint {
  if (probe.amountIn <= 0n || probe.amountOut <= 0n) throw new Error("The price check returned zero; try again.");
  const scaled = ceilDiv(targetYocto * probe.amountIn, probe.amountOut);
  const inUsd = usdMicros(probe.amountInUsd);
  const minIn = inUsd > 0n ? ceilDiv(probe.amountIn * usdMicros(minUsd * 1.02), inUsd) : 0n;
  return scaled > minIn ? scaled : minIn;
}

/** USD value of `amountIn` at the probe's rate (for the "about $X" line and the 50 USD check before asking). */
export const estimateUsd = (amountIn: bigint, probe: Probe): number => (Number(amountIn) / Number(probe.amountIn)) * probe.amountInUsd;

export type StatusKind = "waiting" | "swapping" | "delivered" | "refunded" | "failed" | "incomplete";

/** 1Click's status in the card's words. Null (not read yet) = waiting. */
export function statusKind(status: StatusView["status"] | null): StatusKind {
  switch (status) {
    case "KNOWN_DEPOSIT_TX":
    case "PROCESSING":
      return "swapping";
    case "SUCCESS":
      return "delivered";
    case "REFUNDED":
      return "refunded";
    case "FAILED":
      return "failed";
    case "INCOMPLETE_DEPOSIT":
      return "incomplete";
    default:
      return "waiting";
  }
}

export const savedTopUpSchema = z.object({
  v: z.literal(1),
  /** NEAR account that receives the NEAR. */
  account: z.string(),
  /** The connected EVM wallet when the quote was made (the refund address). */
  evmAddress: z.string(),
  symbol: z.string(),
  decimals: z.number().int().nonnegative(),
  contract: z.string().nullable(),
  quote: topUpQuoteViewSchema,
  /** The account's NEAR balance when the quote was made (yocto string). */
  startNative: z.string().regex(/^\d+$/),
  createdAt: z.number(),
  /** Base transaction hash, once the wallet submitted it. */
  txHash: z.string().optional(),
  sentAt: z.number().optional(),
});
export type SavedTopUp = z.infer<typeof savedTopUpSchema>;

export const savedTopUpKey = (account: string) => `backstop.getnear.${account}`;

/** The remembered swap for `account`, or null when absent, unreadable, for another account, a dry quote, or too old. */
export function parseSavedTopUp(raw: string | null, account: string, nowMs: number): SavedTopUp | null {
  if (!raw) return null;
  try {
    const parsed = savedTopUpSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const s = parsed.data;
    if (s.account !== account || s.quote.recipient !== account || s.quote.dry || !s.quote.depositAddress) return null;
    if (nowMs - s.createdAt > SAVED_MAX_AGE_MS) return null;
    return s;
  } catch {
    return null;
  }
}

/** Nothing has been sent to the deposit address as far as we know. */
export const notSent = (s: SavedTopUp, status: StatusView["status"] | null): boolean => !s.txHash && (status === null || status === "PENDING_DEPOSIT");

/**
 * Whether to forget the remembered quote. Only while nothing was sent: once funds are on their way the card
 * keeps watching whatever the wallet does. The connected EVM account changed (the refund address would no
 * longer be the wallet that sends) = reset. A disconnected wallet (null) keeps it: the user may reconnect.
 */
export function shouldReset(s: SavedTopUp, evmAddress: string | null, status: StatusView["status"] | null): boolean {
  if (!notSent(s, status)) return false;
  return evmAddress !== null && evmAddress.toLowerCase() !== s.evmAddress.toLowerCase();
}

/** Record the submitted transaction (idempotent: the first hash wins). */
export const withTxHash = (s: SavedTopUp, hash: string, nowMs: number): SavedTopUp => (s.txHash ? s : { ...s, txHash: hash, sentAt: nowMs });

export type TopUpView =
  | { kind: "hidden" }
  | { kind: "quote" }
  | { kind: "send" }
  | { kind: "expired" }
  | { kind: "swapping"; stuck: boolean; delivered: boolean }
  | { kind: "unwrap"; amount: bigint; canPayGas: boolean }
  | { kind: "arrived" }
  | { kind: "short"; stuck: boolean }
  | { kind: "refunded" }
  | { kind: "failed" }
  | { kind: "incomplete" };

export type TopUpInput = {
  saved: SavedTopUp | null;
  status: StatusView["status"] | null;
  /** Delivered amount from the status, when known (yocto string). */
  statusAmountOut?: string | undefined;
  /** The account's native NEAR, read from the chain; null until read. */
  nativeYocto: bigint | null;
  /** The account's wNEAR balance; null until read (or not needed). */
  wrappedYocto: bigint | null;
  needYocto: bigint;
  nowMs: number;
  delivery?: NearDelivery;
};

/**
 * Which step the card shows. NEAR counts as arrived only when the NATIVE balance read from the chain covers the
 * need; a 1Click SUCCESS or a wNEAR balance alone never does.
 */
export function deriveTopUp(i: TopUpInput): TopUpView {
  const delivery = i.delivery ?? NEAR_TOPUP_DESTINATION.delivery;
  if (i.nativeYocto !== null && i.nativeYocto >= i.needYocto) return i.saved ? { kind: "arrived" } : { kind: "hidden" };
  const s = i.saved;
  if (!s) return { kind: "quote" };
  const kind = statusKind(i.status);
  if (kind === "refunded") return { kind: "refunded" };
  if (kind === "failed") return { kind: "failed" };
  if (kind === "incomplete") return { kind: "incomplete" };
  if (notSent(s, i.status)) {
    const deadline = s.quote.deadline ? Date.parse(s.quote.deadline) : 0;
    return deadline > i.nowMs ? { kind: "send" } : { kind: "expired" };
  }
  const stuck = i.nowMs - (s.sentAt ?? s.createdAt) > STUCK_MS;
  if (kind === "delivered") {
    if (delivery === "wrapped" && i.wrappedYocto !== null && i.wrappedYocto > 0n) {
      const arrived = i.statusAmountOut && /^\d+$/.test(i.statusAmountOut) ? BigInt(i.statusAmountOut) : BigInt(s.quote.amountOut);
      const amount = i.wrappedYocto < arrived ? i.wrappedYocto : arrived;
      return { kind: "unwrap", amount, canPayGas: (i.nativeYocto ?? 0n) >= NEAR_TOPUP_LIMITS.unwrapGasMinYocto };
    }
    if (i.nativeYocto !== null && i.nativeYocto > BigInt(s.startNative)) return { kind: "short", stuck };
    return { kind: "swapping", stuck, delivered: true };
  }
  return { kind: "swapping", stuck, delivered: false };
}

/**
 * Why a new quote cannot start, or null. With wrapped delivery the account must already hold a little NEAR to
 * unwrap what arrives; without it the swap would leave the NEAR stuck in wrapped form, so we stop before.
 */
export function quoteBlockReason(i: { delivery?: NearDelivery; nativeYocto: bigint | null; accountId: string }): string | null {
  if (i.nativeYocto === null) return "Reading your NEAR balance...";
  const delivery = i.delivery ?? NEAR_TOPUP_DESTINATION.delivery;
  if (delivery === "wrapped" && i.nativeYocto < NEAR_TOPUP_LIMITS.unwrapGasMinYocto) {
    const min = `${formatUnits(NEAR_TOPUP_LIMITS.unwrapGasMinYocto, 24)} NEAR`;
    return `The swap delivers wrapped NEAR, and turning it into spendable NEAR costs a tiny network fee paid in NEAR. ${i.accountId} has less than ${min}, so send at least ${min} to it first (for example from an exchange), then come back here.`;
  }
  return null;
}

export const PROGRESS = ["Quote", "Send", "Swapping", "Arrived"] as const;

/** Index into PROGRESS for the progress line. */
export function progressIndex(v: TopUpView): number {
  switch (v.kind) {
    case "quote":
    case "expired":
    case "hidden":
      return 0;
    case "send":
      return 1;
    case "swapping":
    case "unwrap":
    case "short":
    case "refunded":
    case "failed":
    case "incomplete":
      return 2;
    case "arrived":
      return 3;
  }
}

/** Public status page of a deposit address (for support). */
export const swapStatusUrl = (depositAddress: string) => `${ONE_CLICK.baseUrl}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`;

export const tokenText = (amount: bigint, decimals: number, symbol: string, digits = 6): string =>
  `${Number(formatUnits(amount, decimals)).toLocaleString("en-US", { maximumFractionDigits: digits })} ${symbol}`;

export const usdText = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function durationText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "a few minutes";
  return seconds < 90 ? `about ${Math.round(seconds)} seconds` : `about ${Math.round(seconds / 60)} minutes`;
}

/** POST /api/near-topup/quote. */
export async function requestTopUpQuote(req: TopUpRequest): Promise<TopUpQuoteView> {
  const res = await fetch("/api/near-topup/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = z.object({ error: z.string() }).safeParse(json);
    throw new Error(message.success ? message.data.error : `The quote request failed (HTTP ${res.status}). Try again.`);
  }
  return topUpQuoteViewSchema.parse(json);
}

/**
 * Re-check the server's answer without trusting it: the same signed-field and limit checks the server ran
 * (as of `checkedAtMs`, the time the quote was taken), then the signature with WebCrypto.
 */
export async function verifyTopUpInBrowser(q: TopUpQuoteView, req: TopUpRequest, needYocto: bigint, checkedAtMs: number): Promise<BrowserCheck> {
  const checked = checkTopUpQuote(
    q.canonical,
    { dry: req.dry === true, recipient: req.recipient, refundTo: req.refundTo, originChain: req.originChain, originAsset: req.originAsset, amount: req.amount },
    { depositAddress: q.depositAddress, depositMemo: undefined },
    limitsFor(needYocto),
    checkedAtMs,
  );
  if (!checked.ok) return { ok: false, reason: `The signed quote does not match what was asked (${checked.problems.join("; ")}). Do not send funds to this address.` };
  if (checked.value.depositAddress !== (q.depositAddress ?? null) || checked.value.minAmountOut !== q.minAmountOut || checked.value.amountOut !== q.amountOut) {
    return { ok: false, reason: "The amounts shown are not the signed ones. Do not send funds to this address." };
  }
  return verifySignatureInBrowser(q.canonical, q.signature);
}

/** The request a remembered quote answered (to re-check it after a reload). */
export const requestOf = (s: SavedTopUp): TopUpRequest => ({
  originChain: s.quote.originChain,
  originAsset: s.quote.originAsset,
  amount: s.quote.amountIn,
  recipient: s.quote.recipient,
  refundTo: s.quote.refundTo,
});
