import { describe, expect, it } from "vitest";
import {
  parseBridgeFunded,
  parseConfig,
  parseLimits,
  parseRescueSigned,
  parseStatus,
  rescueJsonArgs,
  txJsonArgs,
} from "../src/policy.js";

const v2Status = {
  spent_today: "0",
  day_start: "1794528000",
  last_rescue_at: "0",
  rescue_count: 0,
  remaining_today: "10000000",
  cooldown_ends_at: "0",
  bridge_spent_today: "3000000",
  bridge_remaining_today: "7000000",
  last_bridge_at: "1794528100",
  bridge_cooldown_ends_at: "1794528700",
  bridge_count: 1,
  last_approve_at: "0",
  last_bridge: null,
};

const v2Config = {
  version: "2.1.0",
  owner: "o.near",
  agent: "a.near",
  base_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  on_behalf_of: "0x000000000000000000000000000000000000beef",
  chain_id: 8453,
  aave_pool: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5",
  usdc_base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  usdc_near: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  bridge_dest_asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  bridge_signer_pk: "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc",
  mpc_contract: "v1.signer",
  derivation_path: "backstop-base-1",
  fee_account: "fees.backstop.near",
  fee_bps: 10,
};

describe("policy contract JSON", () => {
  it("parses get_limits with U128 strings and u64 numbers", () => {
    const l = parseLimits({
      trigger_hf_bps: 11000,
      target_hf_bps: 13000,
      max_per_rescue: "5000000",
      daily_cap: "10000000",
      cooldown_secs: 600,
      max_fee_per_gas: "1000000000",
      max_gas_limit: "400000",
      paused: false,
    });
    expect(l).toEqual({
      triggerHfBps: 11000,
      targetHfBps: 13000,
      maxPerRescue: 5_000_000n,
      dailyCap: 10_000_000n,
      cooldownSecs: 600,
      maxFeePerGas: 1_000_000_000n,
      maxGasLimit: 400_000n,
      paused: false,
    });
  });

  it("parses get_status with the bridge fields", () => {
    expect(parseStatus(v2Status)).toMatchObject({ dayStart: 1794528000, remainingToday: 10_000_000n, bridgeRemainingToday: 7_000_000n, bridgeCount: 1 });
    const lb = { bridge_id: 1, amount_in: "3000000", min_amount_out: "2990000", deposit_address: "ab".repeat(32), funded_at: "1794528100" };
    expect(parseStatus({ ...v2Status, last_bridge: lb }).lastBridge).toEqual({
      bridgeId: 1,
      amountIn: 3_000_000n,
      minAmountOut: 2_990_000n,
      depositAddress: "ab".repeat(32),
      fundedAt: 1794528100,
    });
  });

  it("refuses a v1 get_status (no bridge fields)", () => {
    const { bridge_spent_today: _, ...v1 } = v2Status;
    expect(() => parseStatus(v1)).toThrow(/v2/);
  });

  it("parses get_config v2, checksums addresses and accepts a not-yet-activated policy", () => {
    const c = parseConfig(v2Config);
    expect(c.aavePool).toBe("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
    expect(c.onBehalfOf).toBe("0x000000000000000000000000000000000000bEEF");
    expect(parseConfig({ ...v2Config, base_address: null }).baseAddress).toBeNull();
  });

  it("rejects a view from a contract that is not the policy contract", () => {
    expect(() => parseLimits({ foo: 1 })).toThrow(/POLICY_CONTRACT_ID/);
  });

  it("parses RescueSigned and rejects a malformed signed_tx", () => {
    const ok = { rescue_id: 1, kind: "repay", amount: "2000000", tx_hash: `0x${"ab".repeat(32)}`, signed_tx: "0x02f8" };
    expect(parseRescueSigned(ok)).toMatchObject({ rescueId: 1, amount: 2_000_000n });
    expect(() => parseRescueSigned({ ...ok, signed_tx: "02f8" })).toThrow();
    expect(parseRescueSigned({ ...ok, kind: "approve_pool" }).kind).toBe("approve_pool");
    expect(() => parseRescueSigned({ ...ok, kind: "sweep" })).toThrow();
  });

  it("parses the fund_bridge result", () => {
    const b = { bridge_id: 2, amount_in: "3000000", min_amount_out: "2990000", deposit_address: "cd".repeat(32), quote_hash: "00".repeat(32) };
    expect(parseBridgeFunded(b)).toMatchObject({ bridgeId: 2, amountIn: 3_000_000n, depositAddress: "cd".repeat(32) });
    expect(() => parseBridgeFunded({ ...b, deposit_address: "alice.near" })).toThrow();
  });

  it("sends every rescue integer as a decimal string", () => {
    expect(
      rescueJsonArgs({ amount: 1n, evmNonce: 2, maxFeePerGas: 3n, maxPriorityFeePerGas: 4n, gasLimit: 5n }),
    ).toEqual({ amount: "1", evm_nonce: "2", max_fee_per_gas: "3", max_priority_fee_per_gas: "4", gas_limit: "5" });
    expect(txJsonArgs({ evmNonce: 2, maxFeePerGas: 3n, maxPriorityFeePerGas: 4n, gasLimit: 5n })).toEqual({
      evm_nonce: "2",
      max_fee_per_gas: "3",
      max_priority_fee_per_gas: "4",
      gas_limit: "5",
    });
  });
});
