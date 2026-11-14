/**
 * "Get NEAR" (in-app NEAR top-up through NEAR Intents 1Click): which origin chains and tokens a user may swap
 * from, what is delivered on NEAR, and the limits the web server enforces on every quote. Browser-safe: no
 * Node imports, no env reads. Import it from client code as `@backstop/config/near-topup`.
 *
 * The feature is off unless NEXT_PUBLIC_GET_NEAR_ENABLED=1 (read in apps/web/lib/public-env.ts).
 */
import { AAVE_BASE, BASE, ONE_CLICK } from "./registry.js";

/**
 * How NEAR reaches the user's account:
 * - "native":  the recipient's spendable NEAR balance rises (no extra step).
 * - "wrapped": the recipient receives wNEAR (an NEP-141 token) and must unwrap it with wrap.near
 *              `near_withdraw` (1 yoctoNEAR deposit, paid gas), which needs a little NEAR already in the account.
 */
export type NearDelivery = "native" | "wrapped";

export interface NearTopUpDestination {
  /** 1Click asset id the swap delivers on NEAR. */
  assetId: string;
  delivery: NearDelivery;
  /** The wNEAR contract (unwrap target) when `delivery` is "wrapped". */
  wrapContract: string;
  decimals: number;
}

/**
 * THE switch for what is delivered. 1Click's /v0/tokens lists only wNEAR (`nep141:wrap.near`, 24 decimals) on NEAR,
 * but asking for it with recipientType DESTINATION_CHAIN is delivered as NATIVE NEAR: 1Click's own account calls
 * `intents.near execute_intents` with a `native_withdraw` intent and pays the gas, so the recipient needs no NEAR.
 * Seen on mainnet in tx vZw1iyS3R1Z53XWm3K8vQpy2TtE1DBNLTjaPwro5owg (0.5375 NEAR, 2026-11-08); we have not yet
 * received one ourselves (tools/get-near-test does it with ~3 USDC). "arrived" is judged by the account's native
 * balance read from the chain, so a wrong assumption shows as "short", never as a false success.
 * Set delivery back to "wrapped" to restore the unwrap step.
 */
export const NEAR_TOPUP_DESTINATION: NearTopUpDestination = {
  assetId: "nep141:wrap.near",
  delivery: "native",
  wrapContract: "wrap.near",
  decimals: 24,
};

export interface TopUpOriginAsset {
  /** 1Click asset id; the server also requires it to be in the live /v0/tokens list on `oneClickChain`. */
  assetId: string;
  symbol: "USDC" | "ETH";
  decimals: number;
  /** ERC-20 contract, or null for the chain's native coin. */
  contract: `0x${string}` | null;
  /**
   * Size of the price-discovery (dry) quote, in the token's smallest unit: the app asks 1Click what this much
   * would deliver, then scales to the NEAR it needs. Not a price; about 2-5 USD so it is never refused as dust.
   */
  probeAmount: string;
}

export interface TopUpOrigin {
  /** Key the client sends. */
  key: "base";
  /** 1Click blockchain id. */
  oneClickChain: string;
  evmChainId: number;
  name: string;
  /** What a 1Click deposit address on this chain looks like (refused otherwise). */
  depositAddressPattern: RegExp;
  assets: readonly TopUpOriginAsset[];
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Origin chains the connected EVM wallet can pay from. Base only for now. Adding Arbitrum is one row:
 * `{ key: "arb", oneClickChain: "arb", evmChainId: 42161, name: "Arbitrum", depositAddressPattern: EVM_ADDRESS,
 *    assets: [USDC `nep141:arb-0xaf88...5831.omft.near` (6dp), ETH `nep141:arb.omft.near` (18dp)] }`
 * plus widening the `key` union (asset ids as listed by /v0/tokens on 2026-11-14).
 */
export const NEAR_TOPUP_ORIGINS: readonly TopUpOrigin[] = [
  {
    key: "base",
    oneClickChain: "base",
    evmChainId: BASE.chainId,
    name: BASE.name,
    depositAddressPattern: EVM_ADDRESS,
    assets: [
      { assetId: ONE_CLICK.expectedUsdcBaseAssetId, symbol: "USDC", decimals: 6, contract: AAVE_BASE.usdc, probeAmount: "5000000" },
      { assetId: "nep141:base.omft.near", symbol: "ETH", decimals: 18, contract: null, probeAmount: "2000000000000000" },
    ],
  },
];

export const topUpOrigin = (key: string): TopUpOrigin | undefined => NEAR_TOPUP_ORIGINS.find((o) => o.key === key);

/**
 * Limits on every top-up quote (enforced by the server on the SIGNED quote, re-checked in the browser):
 * - maxUsd: hard ceiling on what one swap may take in, in USD as 1Click signs it (`amountInUsd`).
 * - minUsd: below this 1Click tends to refuse or fees dominate; the app rounds small needs up to it.
 * - capBufferBps: the quote may deliver at most the full creation need (deposit + gas allowance) + 10%.
 * - clientBufferBps: the app asks for the shortfall + 5% to absorb the swap spread.
 * - slippageBps: slippage tolerance sent to 1Click (1%).
 * - unwrapGasMinYocto: NEAR the account must already hold to pay for unwrapping wNEAR (0.01 NEAR).
 */
export const NEAR_TOPUP_LIMITS = {
  maxUsd: 50,
  minUsd: 1,
  capBufferBps: 1_000,
  clientBufferBps: 500,
  slippageBps: 100,
  unwrapGasMinYocto: 10n ** 22n,
} as const;
