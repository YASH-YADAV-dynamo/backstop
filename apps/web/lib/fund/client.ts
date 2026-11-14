"use client";

/** Browser side of fund-from-any-chain (E.9): token list, quote request, and an independent check of what the server returned. */
import { ONE_CLICK } from "@backstop/config/registry";
import { z } from "zod";
import { checkSignedFields, tokenListSchema, type OriginToken, type QuoteRequest, type QuoteView } from "@/lib/fund/shared";
import { base58Decode, base58Encode } from "@/lib/validate";

/** Public token list, fetched straight from 1Click (CORS is open; nothing here is secret). NEAR itself is the other tab. */
export async function fetchOriginTokens(): Promise<OriginToken[]> {
  const res = await fetch(`${ONE_CLICK.baseUrl}/v0/tokens`);
  if (!res.ok) throw new Error(`1Click's token list answered HTTP ${res.status}. Try again in a minute.`);
  return tokenListSchema.parse(await res.json()).filter((t) => t.blockchain !== "near");
}

const PREFERRED = ["USDC", "USDT"];
export const isPreferred = (t: OriginToken) => PREFERRED.includes(t.symbol);

/** Chains that offer USDC or USDT first, then the rest; each group alphabetical by id. */
export function chainsOf(tokens: OriginToken[]): string[] {
  const all = [...new Set(tokens.map((t) => t.blockchain))].sort();
  const stable = new Set(tokens.filter(isPreferred).map((t) => t.blockchain));
  return [...all.filter((c) => stable.has(c)), ...all.filter((c) => !stable.has(c))];
}

/** USDC, USDT first, then alphabetical. */
export function tokensOn(tokens: OriginToken[], chain: string): OriginToken[] {
  return tokens
    .filter((t) => t.blockchain === chain)
    .sort((a, b) => Number(isPreferred(b)) - Number(isPreferred(a)) || PREFERRED.indexOf(a.symbol) - PREFERRED.indexOf(b.symbol) || a.symbol.localeCompare(b.symbol));
}

const quoteViewSchema = z.object({
  policy: z.string(),
  originAsset: z.string(),
  refundTo: z.string(),
  depositAddress: z.string().min(1),
  depositMemo: z.string().optional(),
  amountIn: z.string().regex(/^\d+$/),
  minAmountOut: z.string().regex(/^\d+$/),
  amountOutFormatted: z.string(),
  deadline: z.string(),
  timeEstimate: z.number(),
  signature: z.string(),
  canonical: z.string(),
  extraFee: z.boolean(),
});

export async function requestQuote(req: QuoteRequest): Promise<QuoteView> {
  const res = await fetch("/api/fund/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = z.object({ error: z.string() }).safeParse(json);
    throw new Error(message.success ? message.data.error : `The quote request failed (HTTP ${res.status}). Try again.`);
  }
  return quoteViewSchema.parse(json);
}

export type BrowserCheck = { ok: true; signature: "verified" | "unsupported" } | { ok: false; reason: string };

/**
 * Re-check what the server returned without trusting it: the signed string must name this policy as
 * recipient, NEAR USDC as destination, our refund address, the origin asset and amount, and the same
 * deposit address that is on screen. The ed25519 signature is verified with WebCrypto when the browser
 * supports Ed25519 ("unsupported" otherwise; the server has already verified it).
 */
export async function verifyQuoteInBrowser(q: QuoteView): Promise<BrowserCheck> {
  const mismatches = checkSignedFields(
    q.canonical,
    { recipient: q.policy, destinationAsset: ONE_CLICK.expectedUsdcNearAssetId, refundTo: q.refundTo, originAsset: q.originAsset, amount: q.amountIn },
    q.depositAddress,
    q.depositMemo,
  );
  if (mismatches.length) return { ok: false, reason: `The signed quote does not match what is shown (${mismatches.join("; ")}).` };
  return verifySignatureInBrowser(q.canonical, q.signature);
}

/** Ed25519 check of a 1Click canonical quote string with WebCrypto ("unsupported" when the browser has no Ed25519; the server has already verified it). */
export async function verifySignatureInBrowser(canonical: string, signature: string): Promise<BrowserCheck> {
  const q = { canonical, signature };
  let sig: Uint8Array;
  let pk: Uint8Array;
  try {
    sig = base58Decode(q.signature.replace(/^ed25519:/, ""));
    pk = base58Decode(ONE_CLICK.managerPublicKey.replace(/^ed25519:/, ""));
  } catch {
    return { ok: false, reason: "The 1Click signature on this quote is malformed. Do not send funds to this address." };
  }
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(q.canonical)));
    const message = new TextEncoder().encode(base58Encode(digest));
    const key = await crypto.subtle.importKey("raw", pk as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("Ed25519", key, sig as BufferSource, message);
    return valid ? { ok: true, signature: "verified" } : { ok: false, reason: "The 1Click signature on this quote does not verify. Do not send funds to this address." };
  } catch {
    // This browser has no Ed25519 in WebCrypto: the server already verified the signature.
    return { ok: true, signature: "unsupported" };
  }
}

export const savedFundSchema = z.object({
  quote: quoteViewSchema,
  symbol: z.string(),
  chain: z.string(),
  decimals: z.number(),
  contract: z.string().nullable(),
  createdAt: z.number(),
});
export type SavedFund = z.infer<typeof savedFundSchema>;

export function parseSaved(raw: string | null): SavedFund | null {
  if (!raw) return null;
  try {
    const parsed = savedFundSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const statusViewSchema = z.object({
  status: z.enum(["KNOWN_DEPOSIT_TX", "PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"]),
  updatedAt: z.string(),
  nearTxHashes: z.array(z.string()),
  destinationTxs: z.array(z.object({ hash: z.string(), explorerUrl: z.string() })),
  originTxs: z.array(z.object({ hash: z.string(), explorerUrl: z.string() })),
  amountIn: z.string().optional(),
  amountOut: z.string().optional(),
  refundedAmount: z.string().optional(),
  refundReason: z.string().optional(),
});
export type StatusView = z.infer<typeof statusViewSchema>;
export const TERMINAL = ["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"] as const;

export async function fetchStatus(depositAddress: string): Promise<StatusView> {
  const res = await fetch(`/api/fund/status?depositAddress=${encodeURIComponent(depositAddress)}`, { cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = z.object({ error: z.string() }).safeParse(json);
    throw new Error(message.success ? message.data.error : `Status check failed (HTTP ${res.status}).`);
  }
  return statusViewSchema.parse(json);
}
