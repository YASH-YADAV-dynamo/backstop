import { describe, expect, it } from "vitest";
import { debtKind, fundsReadiness, gasReadiness, isProtected, twoRepaysGasWei, type VaultStatus } from "../src/index.js";

const row = (over: Partial<VaultStatus> = {}): VaultStatus => ({
  policyId: "base-1.vaults.backstop.near",
  chainId: 8453,
  checkedAt: "2026-11-14T12:00:00.000Z",
  state: "watching",
  reason: null,
  lastError: null,
  hf: "1500000000000000000",
  usdc: "10000000",
  usdcWallet: "0",
  gasWei: "1000000000000000",
  debt: "5000000",
  readiness: { funds: "ok", gas: "ok", debt: "usdc" },
  ...over,
});

describe("vault status readiness", () => {
  it("funds_are_low_below_max_per_rescue_and_empty_at_zero", () => {
    expect(fundsReadiness(0n, 5_000_000n)).toBe("empty");
    expect(fundsReadiness(4_999_999n, 5_000_000n)).toBe("low");
    expect(fundsReadiness(5_000_000n, 5_000_000n)).toBe("ok");
  });
  it("gas_need_is_two_repays_at_the_contract_gas_cap_with_the_fee_capped", () => {
    // fee estimate above the contract cap is clamped to the cap, like the agent does
    expect(twoRepaysGasWei(400_000n, 50n, 10n, 100n)).toBe(2n * (400_000n * 10n + 150n));
    expect(twoRepaysGasWei(400_000n, 5n, 10n, 0n)).toBe(2n * 400_000n * 5n);
    expect(gasReadiness(0n, 1n)).toBe("empty");
    expect(gasReadiness(5n, 6n)).toBe("low");
    expect(gasReadiness(6n, 6n)).toBe("ok");
  });
  it("debt_that_is_not_usdc_variable_is_flagged_other", () => {
    expect(debtKind(0n, 0n)).toBe("none");
    expect(debtKind(10n, 0n)).toBe("other");
    expect(debtKind(10n, 1n)).toBe("usdc");
  });
});

describe("isProtected", () => {
  const now = new Date("2026-11-14T12:01:00.000Z");
  it("protected_requires_a_fresh_watching_row_with_funds_gas_and_usdc_debt", () => {
    expect(isProtected(row(), now)).toBe(true);
    expect(isProtected(row({ checkedAt: "2026-11-14T11:58:59.000Z" }), now)).toBe(false);
    expect(isProtected(row({ state: "rescuing" }), now)).toBe(false);
    expect(isProtected(row({ readiness: { funds: "low", gas: "ok", debt: "usdc" } }), now)).toBe(false);
    expect(isProtected(row({ readiness: { funds: "ok", gas: "empty", debt: "usdc" } }), now)).toBe(false);
    expect(isProtected(row({ readiness: { funds: "ok", gas: "ok", debt: "other" } }), now)).toBe(false);
  });
});
