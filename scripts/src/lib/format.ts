import { formatEther, formatUnits, maxUint256 } from "viem";
import type { LoanChain } from "@backstop/config";

export const eth = (wei: bigint) => `${formatEther(wei)} ETH`;
export const usdc = (units: bigint, chain: LoanChain) => `${formatUnits(units, chain.aave.usdcDecimals)} USDC`;
/** Aave "Base" currency values: USD with 8 decimals. */
export const usd8 = (v: bigint) => `$${formatUnits(v, 8)}`;
export const bps = (v: bigint) => `${formatUnits(v, 2)}%`;
/** Health factor (1e18-scaled) as a decimal; max uint256 means no debt. */
export const hf = (v: bigint) => (v === maxUint256 ? "infinite (no debt)" : formatUnits(v, 18));

/** JSON with bigints as decimal strings (for printing unsigned txs). */
export const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
