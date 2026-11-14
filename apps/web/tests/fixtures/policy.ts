/** Builds a PolicySnapshot (the shape readPolicy returns) for a registry chain, with overrides for the field a test breaks. */
import { LOAN_CHAINS, NEAR, ONE_CLICK, POLICY, loanChainByKey, type LoanChain } from "@backstop/config/registry";
import type { Address } from "viem";
import type { PolicyConfig, PolicySnapshot } from "@/lib/policy-client";

export const OWNER = "alice.near";
export const BORROWER = "0x1111111111111111111111111111111111111111" as Address;
export const DERIVED = "0x2222222222222222222222222222222222222222" as Address;

export const baseChain: LoanChain = loanChainByKey("base");
export const arbitrumChain: LoanChain = loanChainByKey("arbitrum");

/** The policy config a factory would create for `chain`: every chain constant from the registry. */
export function configFor(chain: LoanChain, overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    version: POLICY.version,
    owner: OWNER,
    agent: "agent.near",
    base_address: DERIVED,
    on_behalf_of: BORROWER,
    chain_id: chain.chainId,
    aave_pool: chain.aave.pool,
    usdc_base: chain.aave.usdc,
    usdc_near: NEAR.usdcToken,
    bridge_dest_asset: chain.usdcAssetId,
    bridge_signer_pk: ONE_CLICK.managerPublicKey,
    mpc_contract: NEAR.mpcContract,
    derivation_path: NEAR.derivationPath,
    fee_account: "fee.near",
    fee_bps: 10,
    ...overrides,
  };
}

export function snapshotFor(chain: LoanChain, overrides: Partial<PolicyConfig> = {}): PolicySnapshot {
  return {
    policyId: `p-${chain.key}.backstop.near`,
    config: configFor(chain, overrides),
    limits: {
      trigger_hf_bps: 11_000,
      target_hf_bps: 13_000,
      max_per_rescue: 5_000_000n,
      daily_cap: 10_000_000n,
      cooldown_secs: 600n,
      max_fee_per_gas: 2_000_000_000n,
      max_gas_limit: 300_000n,
      paused: false,
    },
    status: {
      spent_today: 0n,
      day_start: 0n,
      last_rescue_at: 0n,
      rescue_count: 0,
      remaining_today: 10_000_000n,
      cooldown_ends_at: 0n,
      bridge_spent_today: 0n,
      bridge_remaining_today: 10_000_000n,
      last_bridge_at: 0n,
      bridge_cooldown_ends_at: 0n,
      bridge_count: 0,
      last_approve_at: 0n,
      last_bridge: null,
    },
    usdcBalance: 20_000_000n,
    account: { amount: 5n * 10n ** 24n, codeHash: "hash", storageUsage: 1000 },
    keyCount: 0,
    derivedAddress: DERIVED,
    fetchedAt: 0,
  };
}

export const CHAINS = LOAN_CHAINS;
