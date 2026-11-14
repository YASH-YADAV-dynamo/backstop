/**
 * zod schemas for the 1Click responses we act on. Fields we use are strict (types, integer
 * strings); everything else passes through untouched so additive API changes don't break us.
 */
import { z } from "zod";

/** Integer amount as a decimal string -> bigint. */
export const intString = z
  .string()
  .regex(/^\d+$/, "expected an integer amount string")
  .transform((s) => BigInt(s));

export const tokenSchema = z
  .object({
    assetId: z.string().min(1),
    decimals: z.number().int().nonnegative(),
    blockchain: z.string().min(1),
    symbol: z.string().min(1),
    contractAddress: z.string().nullish(),
  })
  .passthrough();
export const tokenListSchema = z.array(tokenSchema);
export type Token = z.output<typeof tokenSchema>;

export const swapTypeSchema = z.enum(["EXACT_INPUT", "EXACT_OUTPUT", "FLEX_INPUT", "ANY_INPUT"]);

export const quoteResponseSchema = z
  .object({
    correlationId: z.string(),
    timestamp: z.string(),
    signature: z.string(),
    quoteRequest: z
      .object({
        dry: z.boolean(),
        swapType: swapTypeSchema,
        originAsset: z.string(),
        destinationAsset: z.string(),
        amount: intString,
        recipient: z.string(),
        refundTo: z.string(),
      })
      .passthrough(),
    quote: z
      .object({
        depositAddress: z.string().min(1).optional(),
        depositMemo: z.string().optional(),
        amountIn: intString,
        minAmountIn: intString,
        amountOut: intString,
        minAmountOut: intString,
        deadline: z.string().optional(),
        timeEstimate: z.number().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();
export type QuoteResponse = z.output<typeof quoteResponseSchema>;

export const executionStatusSchema = z.enum([
  "KNOWN_DEPOSIT_TX",
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
]);
export type ExecutionStatus = z.output<typeof executionStatusSchema>;

const txDetailsSchema = z.object({ hash: z.string().min(1), explorerUrl: z.string() }).passthrough();
export type TxDetails = z.output<typeof txDetailsSchema>;

const optionalInt = intString.nullish().transform((v) => v ?? undefined);

export const swapDetailsSchema = z
  .object({
    nearTxHashes: z.array(z.string()).default([]),
    originChainTxHashes: z.array(txDetailsSchema).default([]),
    destinationChainTxHashes: z.array(txDetailsSchema).default([]),
    amountIn: optionalInt,
    amountOut: optionalInt,
    depositedAmount: optionalInt,
    refundedAmount: optionalInt,
    refundReason: z.string().nullish().transform((v) => v ?? undefined),
  })
  .passthrough();

/** Shape shared by GET /v0/status and POST /v0/deposit/submit. */
export const statusResponseSchema = z
  .object({
    correlationId: z.string().optional(),
    status: executionStatusSchema,
    updatedAt: z.string(),
    swapDetails: swapDetailsSchema.default({}),
  })
  .passthrough();
export type StatusResponse = z.output<typeof statusResponseSchema>;
