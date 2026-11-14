/**
 * Typed client for the Backstop policy contract v2 (contracts/policy). Every view and every
 * call result (`rescue`, `approve_pool`, `fund_bridge`) is zod-validated before the agent acts on it.
 */
import type { Provider } from "near-api-js";
import { getAddress, type Address, type Hash, type Hex } from "viem";
import { z } from "zod";
import { viewCall } from "@backstop/chains";
import type { LoanChain } from "@backstop/config";
import type { Limits, PolicyStatus } from "@backstop/core";

/** U128 / U64 cross JSON as decimal strings; plain u32/u64 as numbers. Accept both. */
const uint = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform((v) => BigInt(v));
const evmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x EVM address")
  .transform((a) => getAddress(a));
const hex = (bytes?: number) =>
  z
    .string()
    .regex(bytes ? new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`) : /^0x(?:[0-9a-f]{2})+$/, "expected lowercase 0x hex")
    .transform((s) => s as Hex);

export const configSchema = z.object({
  version: z.string(),
  owner: z.string(),
  agent: z.string(),
  base_address: evmAddress.nullable(),
  on_behalf_of: evmAddress,
  chain_id: z.number().int(),
  aave_pool: evmAddress,
  usdc_base: evmAddress,
  usdc_near: z.string(),
  bridge_dest_asset: z.string(),
  bridge_signer_pk: z.string(),
  mpc_contract: z.string(),
  derivation_path: z.string(),
  fee_account: z.string(),
  fee_bps: z.number().int().nonnegative(),
});

export const limitsSchema = z.object({
  trigger_hf_bps: z.number().int().nonnegative(),
  target_hf_bps: z.number().int().nonnegative(),
  max_per_rescue: uint,
  daily_cap: uint,
  cooldown_secs: uint,
  max_fee_per_gas: uint,
  max_gas_limit: uint,
  paused: z.boolean(),
});

export const statusSchema = z.object({
  spent_today: uint,
  day_start: uint,
  last_rescue_at: uint,
  rescue_count: z.number().int().nonnegative(),
  remaining_today: uint,
  cooldown_ends_at: uint,
  bridge_spent_today: uint,
  bridge_remaining_today: uint,
  last_bridge_at: uint,
  bridge_cooldown_ends_at: uint,
  bridge_count: z.number().int().nonnegative(),
  last_approve_at: uint,
  last_bridge: z
    .object({
      bridge_id: z.number().int().positive(),
      amount_in: uint,
      min_amount_out: uint,
      deposit_address: z.string().regex(/^[0-9a-f]{64}$/, "expected a NEAR implicit account"),
      funded_at: uint,
    })
    .nullable(),
});

export const txKindSchema = z.enum(["repay", "approve_pool"]);
export type TxKind = z.infer<typeof txKindSchema>;

export const rescueSignedSchema = z.object({
  rescue_id: z.number().int().positive(),
  kind: txKindSchema,
  amount: uint,
  tx_hash: hex(32).transform((s) => s as Hash),
  signed_tx: hex(),
});

export const bridgeFundedSchema = z.object({
  bridge_id: z.number().int().positive(),
  amount_in: uint,
  min_amount_out: uint,
  deposit_address: z.string().regex(/^[0-9a-f]{64}$/, "expected a NEAR implicit account"),
  quote_hash: z.string().regex(/^[0-9a-f]{64}$/, "expected 64 hex chars"),
});

export interface PolicyConfig {
  version: string;
  owner: string;
  agent: string;
  /** The derived Base address; null until `activate` ran. */
  baseAddress: Address | null;
  /** The borrower whose USDC debt rescues repay. */
  onBehalfOf: Address;
  chainId: number;
  aavePool: Address;
  usdcBase: Address;
  usdcNear: string;
  bridgeDestAsset: string;
  bridgeSignerPk: string;
  mpcContract: string;
  derivationPath: string;
  /** NEAR account that receives the service fee, and the fee in bps of each bridged amount. */
  feeAccount: string;
  feeBps: number;
}

/** A policy that passed the startup checks: activated, so the derived address is known. `chain` is the registry entry for the policy's `chain_id`, checked against the policy's Pool, USDC and bridge asset. */
export type ActivePolicyConfig = PolicyConfig & { baseAddress: Address; chain: LoanChain };

export interface RescueSigned {
  rescueId: number;
  kind: TxKind;
  amount: bigint;
  txHash: Hash;
  signedTx: Hex;
}

export interface BridgeFunded {
  bridgeId: number;
  amountIn: bigint;
  minAmountOut: bigint;
  depositAddress: string;
  quoteHash: string;
}

/** Nonce and fees the agent picks for a Base tx; the contract builds to / value / data. */
export interface TxArgs {
  evmNonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
}

/** What the agent sends to `rescue`. */
export interface RescueArgs extends TxArgs {
  amount: bigint;
}

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(
      `Policy contract ${what} has an unexpected shape (${issues}). Check that POLICY_CONTRACT_ID runs contracts/policy v2 (a v1 policy must be replaced: deploy a new one with scripts deploy-policy).`,
    );
  }
  return parsed.data;
}

export function parseConfig(raw: unknown): PolicyConfig {
  const c = parse(configSchema, raw, "get_config");
  return {
    version: c.version,
    owner: c.owner,
    agent: c.agent,
    baseAddress: c.base_address,
    onBehalfOf: c.on_behalf_of,
    chainId: c.chain_id,
    aavePool: c.aave_pool,
    usdcBase: c.usdc_base,
    usdcNear: c.usdc_near,
    bridgeDestAsset: c.bridge_dest_asset,
    bridgeSignerPk: c.bridge_signer_pk,
    mpcContract: c.mpc_contract,
    derivationPath: c.derivation_path,
    feeAccount: c.fee_account,
    feeBps: c.fee_bps,
  };
}

export function parseLimits(raw: unknown): Limits {
  const l = parse(limitsSchema, raw, "get_limits");
  return {
    triggerHfBps: l.trigger_hf_bps,
    targetHfBps: l.target_hf_bps,
    maxPerRescue: l.max_per_rescue,
    dailyCap: l.daily_cap,
    cooldownSecs: Number(l.cooldown_secs),
    maxFeePerGas: l.max_fee_per_gas,
    maxGasLimit: l.max_gas_limit,
    paused: l.paused,
  };
}

export function parseStatus(raw: unknown): PolicyStatus {
  const s = parse(statusSchema, raw, "get_status");
  return {
    spentToday: s.spent_today,
    dayStart: Number(s.day_start),
    lastRescueAt: Number(s.last_rescue_at),
    rescueCount: s.rescue_count,
    remainingToday: s.remaining_today,
    cooldownEndsAt: Number(s.cooldown_ends_at),
    bridgeSpentToday: s.bridge_spent_today,
    bridgeRemainingToday: s.bridge_remaining_today,
    lastBridgeAt: Number(s.last_bridge_at),
    bridgeCooldownEndsAt: Number(s.bridge_cooldown_ends_at),
    bridgeCount: s.bridge_count,
    lastApproveAt: Number(s.last_approve_at),
    ...(s.last_bridge && {
      lastBridge: {
        bridgeId: s.last_bridge.bridge_id,
        amountIn: s.last_bridge.amount_in,
        minAmountOut: s.last_bridge.min_amount_out,
        depositAddress: s.last_bridge.deposit_address,
        fundedAt: Number(s.last_bridge.funded_at),
      },
    }),
  };
}

export function parseRescueSigned(raw: unknown): RescueSigned {
  const r = parse(rescueSignedSchema, raw, "rescue / approve_pool result");
  return { rescueId: r.rescue_id, kind: r.kind, amount: r.amount, txHash: r.tx_hash, signedTx: r.signed_tx };
}

export function parseBridgeFunded(raw: unknown): BridgeFunded {
  const b = parse(bridgeFundedSchema, raw, "fund_bridge result");
  return {
    bridgeId: b.bridge_id,
    amountIn: b.amount_in,
    minAmountOut: b.min_amount_out,
    depositAddress: b.deposit_address,
    quoteHash: b.quote_hash,
  };
}

/** JSON args for `approve_pool`: every integer as a decimal string (U64 / U128). */
export function txJsonArgs(a: TxArgs): Record<string, string> {
  return {
    evm_nonce: a.evmNonce.toString(),
    max_fee_per_gas: a.maxFeePerGas.toString(),
    max_priority_fee_per_gas: a.maxPriorityFeePerGas.toString(),
    gas_limit: a.gasLimit.toString(),
  };
}

/** JSON args for `rescue`. */
export function rescueJsonArgs(a: RescueArgs): Record<string, string> {
  return { amount: a.amount.toString(), ...txJsonArgs(a) };
}

export async function readPolicy(
  provider: Provider,
  contractId: string,
): Promise<{ config: PolicyConfig; limits: Limits; status: PolicyStatus }> {
  const [config, limits, status] = await Promise.all([
    viewCall<unknown>(provider, contractId, "get_config").then(parseConfig),
    viewCall<unknown>(provider, contractId, "get_limits").then(parseLimits),
    viewCall<unknown>(provider, contractId, "get_status").then(parseStatus),
  ]);
  return { config, limits, status };
}
