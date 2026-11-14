/**
 * "Get NEAR" types and checks shared by the server route and the browser. No Node imports.
 * Same style as `checkSignedFields` (fund/shared.ts): every routing field is read from the string 1Click
 * SIGNED and compared with what we asked for; any mismatch refuses the quote.
 */
import { NEAR_TOPUP_DESTINATION, NEAR_TOPUP_LIMITS, NEAR_TOPUP_ORIGINS, topUpOrigin, type NearDelivery } from "@backstop/config/near-topup";
import { z } from "zod";
import { isNearAccountId } from "@/lib/validate";

const originKeys = NEAR_TOPUP_ORIGINS.map((o) => o.key) as [string, ...string[]];

/** What the browser may choose. Destination, recipient type, swap type and refund type are fixed by the server. */
export const topUpRequestSchema = z
  .object({
    originChain: z.enum(originKeys),
    originAsset: z.string().min(1).max(200),
    amount: z.string().regex(/^[1-9]\d{0,38}$/, "amount must be a positive integer string in the token's smallest unit"),
    recipient: z.string().refine(isNearAccountId, "must be a NEAR account id"),
    refundTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address on the origin chain"),
    /** true = price discovery only: no deposit address, nothing can be sent to it. */
    dry: z.boolean().optional(),
  })
  .strict();
export type TopUpRequest = z.infer<typeof topUpRequestSchema>;

export const topUpQuoteViewSchema = z.object({
  dry: z.boolean(),
  recipient: z.string(),
  originChain: z.string(),
  originAsset: z.string(),
  refundTo: z.string(),
  destinationAsset: z.string(),
  delivery: z.enum(["native", "wrapped"]),
  /** Absent on a dry quote. */
  depositAddress: z.string().optional(),
  amountIn: z.string().regex(/^\d+$/),
  amountInUsd: z.number(),
  /** Expected NEAR (24 decimals) delivered. */
  amountOut: z.string().regex(/^\d+$/),
  /** Worst case NEAR (24 decimals) delivered. */
  minAmountOut: z.string().regex(/^\d+$/),
  amountOutUsd: z.number().nullable(),
  /** ISO; absent on a dry quote. */
  deadline: z.string().optional(),
  timeEstimate: z.number(),
  signature: z.string(),
  canonical: z.string(),
  /** No partner key configured: the swap service adds 0.25%. */
  extraFee: z.boolean(),
});
export type TopUpQuoteView = z.infer<typeof topUpQuoteViewSchema>;

export type TopUpExpected = {
  dry: boolean;
  recipient: string;
  refundTo: string;
  originChain: string;
  originAsset: string;
  amount: string;
  /** Defaults to NEAR_TOPUP_DESTINATION.assetId: the only destination there is. */
  destinationAsset?: string;
};

export type TopUpLimits = {
  /** Most NEAR (24 decimals) a quote may deliver: the full creation need + capBufferBps. */
  maxOutYocto: bigint;
  maxUsd: number;
  minUsd: number;
};

/** The full creation need (deposit + wallet gas allowance) plus the 10% cap buffer. */
export const maxOutFor = (needYocto: bigint): bigint => (needYocto * (10_000n + BigInt(NEAR_TOPUP_LIMITS.capBufferBps))) / 10_000n;

export const limitsFor = (needYocto: bigint): TopUpLimits => ({ maxOutYocto: maxOutFor(needYocto), maxUsd: NEAR_TOPUP_LIMITS.maxUsd, minUsd: NEAR_TOPUP_LIMITS.minUsd });

export type CheckedTopUp = {
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  amountInUsd: number;
  amountOutUsd: number | null;
  deadline: string | null;
  timeEstimate: number;
  depositAddress: string | null;
};

const POS_INT = /^[1-9]\d{0,38}$/;
const usd = (v: unknown): number | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Check the string 1Click signed against the request and the limits. Returns the problems (empty = good) and,
 * when good, the amounts read from the SIGNED string. `depositAddress`/`depositMemo` are the values shown to
 * the user (from the unsigned part of the answer): they must equal the signed ones.
 */
export function checkTopUpQuote(
  canonical: string,
  expected: TopUpExpected,
  shown: { depositAddress: string | undefined; depositMemo: string | undefined },
  limits: TopUpLimits,
  nowMs: number,
): { ok: true; value: CheckedTopUp } | { ok: false; problems: string[] } {
  let signed: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(canonical);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, problems: ["signed quote is not an object"] };
    signed = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, problems: ["signed quote is not JSON"] };
  }
  const origin = topUpOrigin(expected.originChain);
  if (!origin) return { ok: false, problems: [`origin chain ${expected.originChain} is not supported`] };
  const bad: string[] = [];
  const eq = (field: string, want: unknown) => {
    if (signed[field] !== want) bad.push(`${field} (signed ${JSON.stringify(signed[field])})`);
  };
  eq("dry", expected.dry);
  eq("swapType", "EXACT_INPUT");
  eq("depositType", "ORIGIN_CHAIN");
  eq("recipientType", "DESTINATION_CHAIN");
  eq("refundType", "ORIGIN_CHAIN");
  eq("recipient", expected.recipient);
  eq("destinationAsset", expected.destinationAsset ?? NEAR_TOPUP_DESTINATION.assetId);
  eq("originAsset", expected.originAsset);
  eq("amount", expected.amount);
  eq("amountIn", expected.amount);
  if (typeof signed.refundTo !== "string" || signed.refundTo.toLowerCase() !== expected.refundTo.toLowerCase()) bad.push(`refundTo (signed ${JSON.stringify(signed.refundTo)})`);
  if (!origin.assets.some((a) => a.assetId === expected.originAsset)) bad.push(`originAsset ${expected.originAsset} is not allowed on ${origin.name}`);

  let depositAddress: string | null = null;
  let deadline: string | null = null;
  if (!expected.dry) {
    const addr = signed.depositAddress;
    if (typeof addr !== "string" || !origin.depositAddressPattern.test(addr)) bad.push(`depositAddress (signed ${JSON.stringify(addr)}) is not an address on ${origin.name}`);
    else if (shown.depositAddress !== addr) bad.push("the deposit address shown is not the signed one");
    else depositAddress = addr;
    if (signed.depositMemo !== undefined || shown.depositMemo !== undefined) bad.push("a deposit memo is not expected on this chain");
    const d = signed.deadline;
    const ms = typeof d === "string" ? Date.parse(d) : NaN;
    if (!Number.isFinite(ms)) bad.push("deadline missing");
    else if (ms <= nowMs + 5 * 60_000) bad.push("the deposit address expires too soon (request a new quote)");
    // 1Click ignores the requested 30 min and signs its own deposit window (72 h, measured 2026-11-14).
    // Anything past 7 days (how long a saved swap is kept) is still treated as wrong.
    else if (ms > nowMs + 7 * 24 * 3_600_000) bad.push("deadline is unexpectedly far away");
    else deadline = d as string;
  }

  const amountOut = signed.amountOut;
  const minAmountOut = signed.minAmountOut;
  if (typeof amountOut !== "string" || !POS_INT.test(amountOut)) bad.push("amountOut is not a positive integer");
  if (typeof minAmountOut !== "string" || !POS_INT.test(minAmountOut)) bad.push("minAmountOut is not a positive integer");
  const inUsd = usd(signed.amountInUsd);
  if (inUsd === null) bad.push("amountInUsd missing, so the USD limit cannot be checked");
  if (bad.length) return { ok: false, problems: bad };

  const out = BigInt(amountOut as string);
  const minOut = BigInt(minAmountOut as string);
  if (minOut > out) bad.push("minAmountOut is above amountOut");
  if (inUsd! > limits.maxUsd) bad.push(`it takes in ${inUsd} USD, above the ${limits.maxUsd} USD limit`);
  if (!expected.dry) {
    if (inUsd! < limits.minUsd) bad.push(`it takes in ${inUsd} USD, below the ${limits.minUsd} USD minimum`);
    if (out > limits.maxOutYocto) bad.push("it delivers more NEAR than creating a vault needs (plus 10%)");
  }
  if (bad.length) return { ok: false, problems: bad };
  return {
    ok: true,
    value: {
      amountIn: expected.amount,
      amountOut: amountOut as string,
      minAmountOut: minAmountOut as string,
      amountInUsd: inUsd!,
      amountOutUsd: usd(signed.amountOutUsd),
      deadline,
      timeEstimate: typeof signed.timeEstimate === "number" ? signed.timeEstimate : 0,
      depositAddress,
    },
  };
}

/** The request body 1Click receives. Built only from validated fields; destination and types are constants. */
export function buildTopUpQuoteBody(req: TopUpRequest, nowMs: number, deadlineMs = 30 * 60_000): Record<string, unknown> {
  return {
    dry: req.dry === true,
    swapType: "EXACT_INPUT",
    slippageTolerance: NEAR_TOPUP_LIMITS.slippageBps,
    originAsset: req.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: NEAR_TOPUP_DESTINATION.assetId,
    amount: req.amount,
    refundTo: req.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: req.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(nowMs + deadlineMs).toISOString(),
  };
}

export const currentDelivery = (): NearDelivery => NEAR_TOPUP_DESTINATION.delivery;
