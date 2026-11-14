/**
 * 1Click signed quotes: rebuild the exact string 1Click signs, verify its ed25519 signature, and
 * check every routing field against the policy, exactly as `fund_bridge` does on-chain
 *. The agent runs these before it asks the policy to
 * pay; the contract repeats them, so a bug here can only make the agent refuse, never overpay.
 *
 * Canonical form copied from @defuse-protocol/one-click-sdk-typescript 0.1.26
 * (`buildSignedQuoteRequest`, `buildSignedQuote`, `hashQuote` in dist/index.mjs).
 */
import { NEAR, ONE_CLICK } from "@backstop/config";
import { verifyQuoteSignature, type OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";
import bs58 from "bs58";
import stringify from "json-stable-stringify";
import { createHash, createPublicKey, verify } from "node:crypto";
import { requestRaw, type OneClickOptions } from "./http.js";
import { quoteResponseSchema } from "./schemas.js";

/** Constants mirrored from contracts/policy/src/bridge.rs. */
export const MAX_QUOTE_LEN = 4096;
export const MAX_QUOTE_AGE_SECS = 600;
export const MAX_QUOTE_FUTURE_SECS = 120;
export const MIN_QUOTE_DEADLINE_MARGIN_SECS = 600;
export const MAX_BRIDGE_LOSS_BPS = 200n;
export const MIN_BRIDGE_AMOUNT = 100_000n;

type Json = Record<string, unknown>;

const orUndefined = (v: unknown) => (v ? v : undefined);

function asObject(v: unknown, what: string): Json {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`1Click quote response has no ${what} object; do not bridge, request a new quote.`);
  }
  return v as Json;
}

/**
 * The string 1Click signed: json-stable-stringify of `{ ...signedRequest, ...signedQuote, timestamp }`.
 * `raw` is the untransformed parsed JSON of POST /v0/quote.
 */
export function canonicalQuote(raw: unknown): string {
  const response = asObject(raw, "top-level");
  const req = asObject(response.quoteRequest, "quoteRequest");
  const q = asObject(response.quote, "quote");
  const request = {
    dry: req.dry,
    swapType: req.swapType,
    slippageTolerance: req.slippageTolerance,
    originAsset: req.originAsset,
    depositType: req.depositType,
    destinationAsset: req.destinationAsset,
    amount: req.amount,
    refundTo: req.refundTo,
    refundType: req.refundType,
    recipient: req.recipient,
    recipientType: req.recipientType,
    deadline: req.deadline,
    quoteWaitingTimeMs: orUndefined(req.quoteWaitingTimeMs),
    referral: orUndefined(req.referral),
    virtualChainRecipient: orUndefined(req.virtualChainRecipient),
    virtualChainRefundRecipient: orUndefined(req.virtualChainRefundRecipient),
    customRecipientMsg: orUndefined(req.customRecipientMsg),
  };
  const amounts = {
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted,
    amountInUsd: q.amountInUsd,
    minAmountIn: q.minAmountIn,
    amountOut: q.amountOut,
    amountOutFormatted: q.amountOutFormatted,
    amountOutUsd: q.amountOutUsd,
    minAmountOut: q.minAmountOut,
  };
  const quote = req.dry
    ? amounts
    : {
        ...amounts,
        depositAddress: orUndefined(q.depositAddress),
        depositMemo: orUndefined(q.depositMemo),
        deadline: orUndefined(q.deadline),
        timeWhenInactive: orUndefined(q.timeWhenInactive),
        timeEstimate: orUndefined(q.timeEstimate),
        refundFee: orUndefined(q.refundFee),
        withdrawFee: orUndefined(q.withdrawFee),
      };
  const out = stringify({ ...request, ...quote, timestamp: response.timestamp });
  if (out === undefined) throw new Error("1Click quote could not be serialised; request a new quote.");
  return out;
}

/** The message 1Click signs: UTF-8 bytes of base58(sha256(canonical)). */
export function quoteMessage(canonical: string): Buffer {
  return Buffer.from(bs58.encode(createHash("sha256").update(canonical, "utf8").digest()), "utf8");
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function decodeEd25519(value: string, bytes: number): Uint8Array | undefined {
  if (!value.startsWith("ed25519:")) return undefined;
  try {
    const out = bs58.decode(value.slice("ed25519:".length));
    return out.length === bytes ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Independent ed25519 check with node:crypto (not the SDK's tweetnacl). */
export function verifyCanonicalQuote(
  canonical: string,
  signature: string,
  publicKey: string = ONE_CLICK.managerPublicKey,
): boolean {
  const sig = decodeEd25519(signature, 64);
  const pk = decodeEd25519(publicKey, 32);
  if (!sig || !pk) return false;
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pk]), format: "der", type: "spki" });
  return verify(null, quoteMessage(canonical), key, sig);
}

export interface QuoteExpectations {
  /** The policy account: must be `refundTo`. */
  policyId: string;
  /** The policy's derived Base address: must be `recipient`. */
  derived: string;
  /** NEAR USDC token account id (no `nep141:`). */
  usdcNear: string;
  /** 1Click asset id of Base USDC. */
  destAsset: string;
  nowSecs: number;
  /** Largest amountIn the caller is willing to pay (USDC 6dp). */
  maxAmountIn: bigint;
}

export interface CheckedQuote {
  amountIn: bigint;
  minAmountOut: bigint;
  depositAddress: string;
  deadlineSecs: number;
  timestampSecs: number;
}

/** Field names the contract accepts; anything else is ERR_QUOTE_SHAPE (fail closed). */
const ALLOWED_FIELDS = new Set([
  "dry", "swapType", "depositType", "originAsset", "destinationAsset", "recipient", "recipientType",
  "refundTo", "refundType", "depositAddress", "amount", "amountIn", "minAmountIn", "amountOut",
  "minAmountOut", "deadline", "timestamp", "slippageTolerance", "amountInFormatted", "amountInUsd",
  "amountOutFormatted", "amountOutUsd", "timeWhenInactive", "timeEstimate", "refundFee", "withdrawFee",
  "quoteWaitingTimeMs", "referral",
]);
const STRING_FIELDS = [
  "swapType", "depositType", "originAsset", "destinationAsset", "recipient", "recipientType", "refundTo",
  "refundType", "depositAddress", "amount", "amountIn", "minAmountIn", "amountOut", "minAmountOut",
  "deadline", "timestamp",
] as const;

const U128_MAX = 2n ** 128n - 1n;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z$/;

/** Same grammar as the contract's `parse_iso_utc`: whole seconds, UTC `Z` only. */
export function parseIsoUtcSecs(s: string): number | undefined {
  const m = ISO_RE.exec(s);
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59) return undefined;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > daysInMonth) return undefined;
  return Date.UTC(y, mo - 1, d, h, mi, se) / 1000;
}

const fail = (code: string, detail: string): never => {
  throw new Error(`${code}: ${detail}. Do not bridge with this quote; request a new one.`);
};

/** C.6 rows 4 and 7-23 (plus the caller's cap), with the contract's error codes. Pure. */
export function assertQuoteForPolicy(canonical: string, expected: QuoteExpectations): CheckedQuote {
  if (canonical.length > MAX_QUOTE_LEN) fail("ERR_QUOTE_TOO_LONG", `${canonical.length} > ${MAX_QUOTE_LEN} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical);
  } catch {
    return fail("ERR_QUOTE_SHAPE", "not JSON");
  }
  const q = asObject(parsed, "quote");
  const unknown = Object.keys(q).filter((k) => !ALLOWED_FIELDS.has(k));
  if (unknown.length) fail("ERR_QUOTE_SHAPE", `unexpected field(s) ${unknown.join(", ")}`);
  if (typeof q.dry !== "boolean") fail("ERR_QUOTE_SHAPE", "dry is not a boolean");
  for (const f of STRING_FIELDS) if (typeof q[f] !== "string") fail("ERR_QUOTE_SHAPE", `${f} missing or not a string`);
  const s = q as Record<(typeof STRING_FIELDS)[number], string> & { dry: boolean };

  if (s.dry) fail("ERR_QUOTE_DRY", "a dry quote has no usable deposit address");
  if (s.swapType !== "EXACT_INPUT") fail("ERR_QUOTE_SWAP_TYPE", `swapType is ${s.swapType}`);
  if (s.depositType !== "ORIGIN_CHAIN") fail("ERR_QUOTE_DEPOSIT_TYPE", `depositType is ${s.depositType}`);
  if (s.originAsset !== `nep141:${expected.usdcNear}`) fail("ERR_QUOTE_ORIGIN_ASSET", `originAsset is ${s.originAsset}`);
  if (s.destinationAsset !== expected.destAsset) fail("ERR_QUOTE_DESTINATION_ASSET", `destinationAsset is ${s.destinationAsset}`);
  if (s.recipientType !== "DESTINATION_CHAIN") fail("ERR_QUOTE_RECIPIENT_TYPE", `recipientType is ${s.recipientType}`);
  if (s.recipient.toLowerCase() !== expected.derived.toLowerCase()) {
    fail("ERR_QUOTE_RECIPIENT", `recipient ${s.recipient} is not the derived address ${expected.derived}`);
  }
  if (s.refundType !== "ORIGIN_CHAIN") fail("ERR_QUOTE_REFUND_TYPE", `refundType is ${s.refundType}`);
  if (s.refundTo !== expected.policyId) fail("ERR_QUOTE_REFUND_TO", `refundTo ${s.refundTo} is not the policy ${expected.policyId}`);
  if (!/^[0-9a-f]{64}$/.test(s.depositAddress)) {
    fail("ERR_QUOTE_DEPOSIT_ADDRESS", `depositAddress ${s.depositAddress} is not a NEAR implicit account`);
  }
  const amounts = [s.amount, s.amountIn, s.minAmountIn, s.amountOut, s.minAmountOut];
  if (!amounts.every((a) => /^\d{1,39}$/.test(a) && BigInt(a) <= U128_MAX)) {
    fail("ERR_QUOTE_AMOUNT_FORMAT", "an amount is not a u128 string");
  }
  const [amount, amountIn, minAmountIn, , minAmountOut] = amounts.map(BigInt) as [bigint, bigint, bigint, bigint, bigint];
  if (amount !== amountIn || minAmountIn !== amountIn) fail("ERR_QUOTE_AMOUNT_MISMATCH", "amount, amountIn and minAmountIn differ");
  if (amountIn < MIN_BRIDGE_AMOUNT) fail("ERR_BRIDGE_AMOUNT_TOO_SMALL", `amountIn ${amountIn} < ${MIN_BRIDGE_AMOUNT}`);
  if (minAmountOut * 10_000n < amountIn * (10_000n - MAX_BRIDGE_LOSS_BPS)) {
    fail("ERR_QUOTE_LOSS_TOO_HIGH", `minAmountOut ${minAmountOut} is below 98% of amountIn ${amountIn}`);
  }
  const ts = parseIsoUtcSecs(s.timestamp);
  if (ts === undefined) return fail("ERR_QUOTE_TIME_FORMAT", `timestamp ${s.timestamp}`);
  if (ts < expected.nowSecs - MAX_QUOTE_AGE_SECS || ts > expected.nowSecs + MAX_QUOTE_FUTURE_SECS) {
    fail("ERR_QUOTE_STALE", `timestamp ${s.timestamp} is not within ${MAX_QUOTE_AGE_SECS}s of now`);
  }
  const deadline = parseIsoUtcSecs(s.deadline);
  if (deadline === undefined) return fail("ERR_QUOTE_TIME_FORMAT", `deadline ${s.deadline}`);
  if (deadline < expected.nowSecs + MIN_QUOTE_DEADLINE_MARGIN_SECS) {
    fail("ERR_QUOTE_DEADLINE_TOO_SOON", `deposit address expires at ${s.deadline}`);
  }
  if (amountIn > expected.maxAmountIn) fail("ERR_OVER_MAX_PER_RESCUE", `amountIn ${amountIn} > allowed ${expected.maxAmountIn}`);
  return { amountIn, minAmountOut, depositAddress: s.depositAddress, deadlineSecs: deadline, timestampSecs: ts };
}

export interface BridgeQuoteParams {
  /** USDC (NEAR, 6dp) the policy will pay. EXACT_INPUT: exactly this leaves the policy. */
  amountIn: bigint;
  /** The policy's derived address on the loan chain (receives that chain's USDC). */
  recipient: string;
  /** The policy's `bridge_dest_asset`: 1Click asset id of USDC on its loan chain. */
  destAsset: string;
  /** The policy account (receives refunds on NEAR). */
  refundTo: string;
  /** Default 50 (0.5%). The contract refuses more than 2% loss whatever this says. */
  slippageBps?: number;
  /** When the deposit address may stop accepting; default now + 30 minutes. */
  deadline?: Date;
  /** Clock for the freshness checks; default Date.now(). */
  nowMs?: number;
}

export interface BridgeQuote {
  /** The exact string 1Click signed: pass it to `fund_bridge` as `quote`. */
  canonical: string;
  /** `ed25519:<base58>`: pass it to `fund_bridge` as `signature`. */
  signature: string;
  amountIn: bigint;
  minAmountOut: bigint;
  depositAddress: string;
  deadlineSecs: number;
  /** 1Click's estimate in seconds after the deposit confirms. */
  timeEstimate: number;
  correlationId: string;
}

/**
 * POST /v0/quote (non-dry, EXACT_INPUT, NEAR USDC -> Base USDC) for a policy-funded bridge. Three
 * independent checks must pass or it throws: the SDK's `verifyQuoteSignature`, our own
 * `verifyCanonicalQuote` (node:crypto), and `assertQuoteForPolicy` (the contract's field checks).
 */
export async function bridgeQuote(params: BridgeQuoteParams, opts: OneClickOptions = {}): Promise<BridgeQuote> {
  if (params.amountIn < MIN_BRIDGE_AMOUNT) {
    throw new Error(`bridgeQuote amountIn ${params.amountIn} is below the policy minimum ${MIN_BRIDGE_AMOUNT} (0.1 USDC).`);
  }
  const slippageBps = params.slippageBps ?? 50;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || BigInt(slippageBps) > MAX_BRIDGE_LOSS_BPS) {
    throw new Error(`slippageBps must be an integer 0..${MAX_BRIDGE_LOSS_BPS} (got ${slippageBps}); the policy refuses more loss.`);
  }
  const nowMs = params.nowMs ?? Date.now();
  const deadline = params.deadline ?? new Date(nowMs + 30 * 60_000);
  const { data, raw } = await requestRaw(
    "/v0/quote",
    quoteResponseSchema,
    {
      method: "POST",
      body: {
        dry: false,
        swapType: "EXACT_INPUT",
        slippageTolerance: slippageBps,
        originAsset: ONE_CLICK.expectedUsdcNearAssetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: params.destAsset,
        amount: params.amountIn.toString(),
        refundTo: params.refundTo,
        refundType: "ORIGIN_CHAIN",
        recipient: params.recipient,
        recipientType: "DESTINATION_CHAIN",
        deadline: deadline.toISOString(),
      },
    },
    opts,
  );
  if (!verifyQuoteSignature(raw as OneClickQuoteResponse, ONE_CLICK.managerPublicKey)) {
    throw new Error("ERR_QUOTE_SIGNATURE_INVALID: the 1Click SDK rejects the quote signature. Do not bridge; request a new quote.");
  }
  const canonical = canonicalQuote(raw);
  if (!verifyCanonicalQuote(canonical, data.signature)) {
    throw new Error("ERR_QUOTE_SIGNATURE_INVALID: the rebuilt quote string does not verify. Do not bridge; request a new quote.");
  }
  const checked = assertQuoteForPolicy(canonical, {
    policyId: params.refundTo,
    derived: params.recipient,
    usdcNear: NEAR.usdcToken,
    destAsset: params.destAsset,
    nowSecs: Math.floor(nowMs / 1000),
    maxAmountIn: params.amountIn,
  });
  if (checked.amountIn !== params.amountIn) {
    throw new Error(`ERR_QUOTE_AMOUNT_MISMATCH: 1Click quoted amountIn ${checked.amountIn}, requested ${params.amountIn}. Request a new quote.`);
  }
  return {
    canonical,
    signature: data.signature,
    amountIn: checked.amountIn,
    minAmountOut: checked.minAmountOut,
    depositAddress: checked.depositAddress,
    deadlineSecs: checked.deadlineSecs,
    timeEstimate: data.quote.timeEstimate,
    correlationId: data.correlationId,
  };
}
