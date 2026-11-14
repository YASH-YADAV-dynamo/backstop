/** Fund-from-any-chain types and checks shared by the server routes and the browser (E.9). No Node imports. */
import { z } from "zod";
import { isNearAccountId } from "@/lib/validate";

export const tokenSchema = z
  .object({
    assetId: z.string().min(1),
    decimals: z.number().int().nonnegative().max(36),
    blockchain: z.string().min(1),
    symbol: z.string().min(1),
    contractAddress: z.string().nullish(),
  })
  .passthrough();
export const tokenListSchema = z.array(tokenSchema);
export type OriginToken = z.output<typeof tokenSchema>;

/** Printable ASCII, 1..128 chars: the refund address on the origin chain (format differs per chain; 1Click validates it). */
const refundTo = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/, "refund address must be printable characters without spaces");

export const quoteRequestSchema = z
  .object({
    policy: z.string().refine(isNearAccountId, "must be a NEAR account id"),
    originAsset: z.string().min(1).max(200),
    amount: z.string().regex(/^[1-9]\d{0,38}$/, "amount must be a positive integer string in the token's smallest unit"),
    refundTo,
  })
  .strict();
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export type QuoteView = {
  policy: string;
  originAsset: string;
  refundTo: string;
  depositAddress: string;
  depositMemo?: string;
  /** Origin-token amount to send, smallest unit */
  amountIn: string;
  /** Worst-case NEAR USDC delivered to the policy, 6dp */
  minAmountOut: string;
  amountOutFormatted: string;
  /** ISO time after which the deposit address stops being valid */
  deadline: string;
  timeEstimate: number;
  signature: string;
  /** The exact string 1Click signed. The browser re-checks it. */
  canonical: string;
  /** True when no 1Click key is configured: 1Click adds 0.25%. */
  extraFee: boolean;
};

/** Origin chains whose deposit we can send from the connected EVM wallet. */
export const EVM_CHAINS: Record<string, number> = { eth: 1, base: 8453, arb: 42161, op: 10, pol: 137, bsc: 56, gnosis: 100, avax: 43114 };

export const CHAIN_NAMES: Record<string, string> = {
  eth: "Ethereum", base: "Base", arb: "Arbitrum", op: "Optimism", pol: "Polygon", bsc: "BNB Chain", gnosis: "Gnosis",
  avax: "Avalanche", sol: "Solana", btc: "Bitcoin", doge: "Dogecoin", ltc: "Litecoin", xrp: "XRP Ledger", ton: "TON",
  tron: "Tron", sui: "Sui", aptos: "Aptos", stellar: "Stellar", cardano: "Cardano", bera: "Berachain", zec: "Zcash",
  near: "NEAR", starknet: "Starknet", bch: "Bitcoin Cash", adi: "ADI", plasma: "Plasma", monad: "Monad", xlayer: "X Layer",
  scroll: "Scroll", aleo: "Aleo",
};
export const chainName = (id: string) => CHAIN_NAMES[id] ?? id.toUpperCase();

export type SignedFields = {
  recipient: string;
  destinationAsset: string;
  refundTo: string;
  originAsset: string;
  amount: string;
};

/**
 * Compare the fields 1Click signed with what we asked for. `canonical` is the signed string.
 * Returns the list of mismatches (empty = all good). Used by the server before it shows an address
 * and again by the browser before it shows the QR.
 */
export function checkSignedFields(canonical: string, expected: SignedFields, depositAddress: string, depositMemo: string | undefined): string[] {
  let signed: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(canonical);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return ["signed quote is not an object"];
    signed = parsed as Record<string, unknown>;
  } catch {
    return ["signed quote is not JSON"];
  }
  const bad: string[] = [];
  const eq = (field: string, want: unknown) => {
    if (signed[field] !== want) bad.push(`${field} (signed ${JSON.stringify(signed[field])})`);
  };
  eq("dry", false);
  eq("swapType", "EXACT_INPUT");
  eq("depositType", "ORIGIN_CHAIN");
  eq("recipientType", "DESTINATION_CHAIN");
  eq("refundType", "ORIGIN_CHAIN");
  eq("recipient", expected.recipient);
  eq("destinationAsset", expected.destinationAsset);
  eq("refundTo", expected.refundTo);
  eq("originAsset", expected.originAsset);
  eq("amount", expected.amount);
  eq("depositAddress", depositAddress);
  if (depositMemo !== undefined || signed.depositMemo !== undefined) eq("depositMemo", depositMemo);
  return bad;
}
