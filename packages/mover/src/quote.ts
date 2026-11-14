import { requestJson, type OneClickOptions } from "./http.js";
import type { LoanChain } from "@backstop/config";
import { resolveUsdcAssets, type UsdcAssets } from "./assets.js";
import { quoteResponseSchema, type QuoteResponse } from "./schemas.js";

/**
 * Amount to quote, USDC 6dp.
 * - `amountOut` (EXACT_OUTPUT, preferred): a rescue needs at least X USDC to land on Base, so we fix
 *   the output and let 1Click size the input. Slippage is applied to the input side: the quote's
 *   `amountIn` already includes the buffer and anything not needed is refunded to `refundTo`.
 *   1Click supports EXACT_OUTPUT for NEAR USDC -> Base USDC (verified with a live dry quote).
 * - `amountIn` (EXACT_INPUT): spend exactly X; what arrives is `minAmountOut` at worst. Use it only
 *   when the input is what's fixed (e.g. "move my whole balance").
 */
export type QuoteAmount = { amountOut: bigint; amountIn?: never } | { amountIn: bigint; amountOut?: never };

export type QuoteParams = QuoteAmount & {
  /** true = price check only, no deposit address is created. */
  dry: boolean;
  /** Base (EVM) address that receives USDC. */
  recipient: string;
  /** NEAR account that gets refunds on NEAR. */
  refundTo: string;
  /** Default 50 (0.5%). */
  slippageBps?: number;
  /** Default now + 30 minutes. */
  deadline?: Date;
  /** The loan chain whose USDC is the destination; required when `assets` is omitted. */
  chain?: LoanChain;
  /** Resolved via resolveUsdcAssets(chain) when omitted. */
  assets?: UsdcAssets;
};

export interface QuoteResult {
  dry: boolean;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT";
  originAsset: string;
  destinationAsset: string;
  /** USDC (NEAR) to deposit, 6dp. For EXACT_OUTPUT this includes the slippage buffer. */
  amountIn: bigint;
  minAmountIn: bigint;
  /** USDC (Base) expected, 6dp. */
  amountOut: bigint;
  minAmountOut: bigint;
  /** Seconds after the deposit confirms. */
  timeEstimate: number;
  /** Present when dry = false. */
  depositAddress?: string;
  depositMemo?: string;
  deadline?: string;
  correlationId: string;
  /** 1Click's signature over the quote: keep it with the record to resolve disputes. */
  signature: string;
  raw: QuoteResponse;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** POST /v0/quote for NEAR USDC -> Base USDC. Validates the response echoes our request before returning it. */
export async function quote(params: QuoteParams, opts: OneClickOptions = {}): Promise<QuoteResult> {
  const exactOutput = params.amountOut !== undefined;
  const amount = exactOutput ? params.amountOut : params.amountIn;
  if (amount === undefined || amount <= 0n) {
    throw new Error("quote() needs a positive amountOut (EXACT_OUTPUT) or amountIn (EXACT_INPUT) in USDC 6dp.");
  }
  if (!EVM_ADDRESS.test(params.recipient)) {
    throw new Error(`quote() recipient must be an EVM address 0x + 40 hex chars (got "${params.recipient}").`);
  }
  const slippageBps = params.slippageBps ?? 50;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippageBps must be an integer 0..10000 (got ${slippageBps}).`);
  }
  if (!params.assets && !params.chain) throw new Error("quote() needs `chain` (the loan chain) or pre-resolved `assets`.");
  const assets = params.assets ?? (await resolveUsdcAssets(params.chain!, opts));
  const swapType = exactOutput ? "EXACT_OUTPUT" : "EXACT_INPUT";
  const deadline = params.deadline ?? new Date(Date.now() + 30 * 60_000);

  const res = await requestJson(
    "/v0/quote",
    quoteResponseSchema,
    {
      method: "POST",
      body: {
        dry: params.dry,
        swapType,
        slippageTolerance: slippageBps,
        originAsset: assets.near.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: assets.dest.assetId,
        amount: amount.toString(),
        refundTo: params.refundTo,
        refundType: "ORIGIN_CHAIN",
        recipient: params.recipient,
        recipientType: "DESTINATION_CHAIN",
        deadline: deadline.toISOString(),
      },
    },
    opts,
  );

  const echo = res.quoteRequest;
  const mismatch: string[] = [];
  if (echo.swapType !== swapType) mismatch.push(`swapType ${echo.swapType}`);
  if (echo.originAsset !== assets.near.assetId) mismatch.push(`originAsset ${echo.originAsset}`);
  if (echo.destinationAsset !== assets.dest.assetId) mismatch.push(`destinationAsset ${echo.destinationAsset}`);
  if (echo.recipient.toLowerCase() !== params.recipient.toLowerCase()) mismatch.push(`recipient ${echo.recipient}`);
  if (echo.refundTo !== params.refundTo) mismatch.push(`refundTo ${echo.refundTo}`);
  if (echo.amount !== amount) mismatch.push(`amount ${echo.amount}`);
  if (mismatch.length) {
    throw new Error(`1Click quote does not match our request (${mismatch.join(", ")}). Do not deposit; request a new quote.`);
  }
  const q = res.quote;
  if (exactOutput && q.minAmountOut < amount) {
    throw new Error(
      `1Click EXACT_OUTPUT quote guarantees only ${q.minAmountOut} out but ${amount} was requested. Do not deposit; request a new quote.`,
    );
  }
  if (!params.dry && !q.depositAddress) {
    throw new Error("1Click returned a non-dry quote without a depositAddress. Do not deposit; request a new quote.");
  }

  return {
    dry: params.dry,
    swapType,
    originAsset: assets.near.assetId,
    destinationAsset: assets.dest.assetId,
    amountIn: q.amountIn,
    minAmountIn: q.minAmountIn,
    amountOut: q.amountOut,
    minAmountOut: q.minAmountOut,
    timeEstimate: q.timeEstimate,
    ...(q.depositAddress !== undefined && { depositAddress: q.depositAddress }),
    ...(q.depositMemo !== undefined && { depositMemo: q.depositMemo }),
    ...(q.deadline !== undefined && { deadline: q.deadline }),
    correlationId: res.correlationId,
    signature: res.signature,
    raw: res,
  };
}
