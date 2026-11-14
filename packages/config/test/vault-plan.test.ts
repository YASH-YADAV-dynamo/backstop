import { describe, expect, it } from "vitest";
import { AAVE_BASE, NEAR, ONE_CLICK, loanChainByKey } from "../src/registry.js";
import { deployBudget, policyInitArgs, STORAGE_BYTE_YOCTO, vaultCreateDeposit } from "../src/vault-plan.js";

const limits = {
  trigger_hf_bps: 11_000,
  target_hf_bps: 13_000,
  max_per_rescue: "5000000",
  daily_cap: "10000000",
  cooldown_secs: 600,
  max_fee_per_gas: "1000000000",
  max_gas_limit: "400000",
};

describe("vault plan", () => {
  it("the_create_deposit_covers_code_state_spare_usdc_registration_and_gas", () => {
    const b = deployBudget(277_247, STORAGE_BYTE_YOCTO, BigInt(NEAR.usdcStorageDeposit));
    expect(vaultCreateDeposit(277_247)).toBe(b.deployerNeeds);
    expect(b.deployerNeeds).toBe(b.codeStake + b.stateMargin + b.spare + b.storageDeposit + b.gasReserve);
    // 2.77247 code + 0.05 state + 0.1 spare + 0.00125 USDC registration + 0.02 gas
    expect(vaultCreateDeposit(277_247)).toBe(2_943_720_000_000_000_000_000_000n);
  });

  it("refuses_a_nonsense_wasm_size", () => {
    expect(() => vaultCreateDeposit(0)).toThrow(/wasm size/);
    expect(() => vaultCreateDeposit(1.5)).toThrow(/wasm size/);
  });

  it("init_args_take_every_constant_from_the_registry", () => {
    const args = policyInitArgs({ chain: loanChainByKey("base"), owner: "alice.near", agent: "bot.near", borrower: "0x000000000000000000000000000000000000bEEF", limits, feeAccount: "fees.near", feeBps: 10 });
    expect(args).toMatchObject({ owner: "alice.near", agent: "bot.near", aave_pool: AAVE_BASE.pool, bridge_signer_pk: ONE_CLICK.managerPublicKey, limits, fee_bps: 10 });
    expect(() => policyInitArgs({ chain: loanChainByKey("base"), owner: "a.near", agent: "b.near", borrower: "nope", limits, feeAccount: "f.near", feeBps: 10 })).toThrow(/borrower/);
    expect(() => policyInitArgs({ chain: loanChainByKey("base"), owner: "a.near", agent: "b.near", borrower: "0x000000000000000000000000000000000000bEEF", limits, feeAccount: "f.near", feeBps: 51 })).toThrow(/FEE_BPS/);
  });
});
