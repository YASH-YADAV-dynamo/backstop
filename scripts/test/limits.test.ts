import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  decimalToUnits,
  hasLimitFlags,
  limitsFromFlags,
  limitsFromView,
  validateLimits,
  type LimitsJson,
} from "../src/lib/limits.js";

describe("limit flags convert human units to the contract's integer units", () => {
  it("converts HF to bps, USDC to 6dp, gwei to wei, exactly", () => {
    const l = limitsFromFlags(
      {
        trigger: "1.05",
        target: "1.5",
        "max-per-rescue": "2.5",
        "daily-cap": "12.000001",
        cooldown: "300",
        "max-fee-gwei": "0.05",
        "max-gas": "350000",
      },
      DEFAULT_LIMITS,
    );
    expect(l).toEqual({
      trigger_hf_bps: 10_500,
      target_hf_bps: 15_000,
      max_per_rescue: "2500000",
      daily_cap: "12000001",
      cooldown_secs: 300,
      max_fee_per_gas: "50000000",
      max_gas_limit: "350000",
    });
  });

  it("keeps the base value for every flag left out", () => {
    expect(limitsFromFlags({}, DEFAULT_LIMITS)).toEqual(DEFAULT_LIMITS);
    expect(limitsFromFlags({ cooldown: "60" }, DEFAULT_LIMITS)).toEqual({ ...DEFAULT_LIMITS, cooldown_secs: 60 });
  });

  it("default limits are the documented ones (HF 1.1 -> 1.3, 5 USDC, 10 USDC/day, 600 s, 1 gwei, 400k gas)", () => {
    expect(DEFAULT_LIMITS).toEqual({
      trigger_hf_bps: 11_000,
      target_hf_bps: 13_000,
      max_per_rescue: "5000000",
      daily_cap: "10000000",
      cooldown_secs: 600,
      max_fee_per_gas: "1000000000",
      max_gas_limit: "400000",
    });
    expect(() => validateLimits(DEFAULT_LIMITS)).not.toThrow();
  });
});

describe("values that would be rounded or misread are rejected, not guessed", () => {
  it("rejects more decimals than the unit has instead of rounding", () => {
    expect(() => decimalToUnits("max-per-rescue", "1.0000001", 6)).toThrow(/at most 6 decimal places/);
    expect(() => limitsFromFlags({ trigger: "1.00001" }, DEFAULT_LIMITS)).toThrow(/at most 4 decimal places/);
    expect(() => limitsFromFlags({ cooldown: "1.5" }, DEFAULT_LIMITS)).toThrow(/at most 0 decimal places/);
  });

  it("rejects negatives, exponents, hex and empty strings", () => {
    for (const bad of ["-1", "1e6", "0x10", "", " ", "1.", ".5", "abc"]) {
      expect(() => decimalToUnits("daily-cap", bad, 6)).toThrow(/--daily-cap/);
    }
  });

  it("rejects HF values that do not fit the contract's u32 bps", () => {
    expect(() => limitsFromFlags({ trigger: "1", target: "500000" }, DEFAULT_LIMITS)).toThrow(/--target is too large/);
  });
});

describe("client-side validation matches Limits::validate in the contract", () => {
  const ok: LimitsJson = DEFAULT_LIMITS;

  it("target HF must be strictly above trigger HF", () => {
    expect(() => validateLimits({ ...ok, target_hf_bps: ok.trigger_hf_bps })).toThrow(/^ERR_TARGET_HF_NOT_ABOVE_TRIGGER/);
    expect(() => limitsFromFlags({ trigger: "1.4", target: "1.3" }, ok)).toThrow(/^ERR_TARGET_HF_NOT_ABOVE_TRIGGER/);
  });

  it("max per rescue must be > 0", () => {
    expect(() => limitsFromFlags({ "max-per-rescue": "0" }, ok)).toThrow(/^ERR_MAX_PER_RESCUE_ZERO/);
  });

  it("max per rescue must be <= daily cap (equal is allowed)", () => {
    expect(() => limitsFromFlags({ "max-per-rescue": "10.000001" }, ok)).toThrow(/^ERR_MAX_PER_RESCUE_ABOVE_DAILY_CAP/);
    expect(limitsFromFlags({ "max-per-rescue": "10" }, ok).max_per_rescue).toBe("10000000");
  });

  it("max fee per gas and max gas limit must be > 0", () => {
    expect(() => limitsFromFlags({ "max-fee-gwei": "0" }, ok)).toThrow(/^ERR_MAX_FEE_PER_GAS_ZERO/);
    expect(() => limitsFromFlags({ "max-gas": "0" }, ok)).toThrow(/^ERR_MAX_GAS_LIMIT_ZERO/);
  });

  it("a zero cooldown is rejected, as in the contract", () => {
    expect(() => limitsFromFlags({ cooldown: "0" }, ok)).toThrow(/^ERR_COOLDOWN_ZERO/);
  });
});

describe("set-limits starts from the on-chain limits", () => {
  it("reads get_limits (U128 strings, u32/u64 numbers) and drops paused", () => {
    const view = { ...DEFAULT_LIMITS, paused: true };
    expect(limitsFromView(view)).toEqual(DEFAULT_LIMITS);
  });

  it("refuses a get_limits response that is not the policy contract's shape", () => {
    expect(() => limitsFromView({ trigger_hf_bps: 11000 })).toThrow(/unexpected shape.*target_hf_bps/);
    expect(() => limitsFromView(null)).toThrow(/unexpected shape/);
    expect(() => limitsFromView({ ...DEFAULT_LIMITS, daily_cap: "-1" })).toThrow(/daily_cap/);
  });

  it("detects whether any limit flag was given", () => {
    expect(hasLimitFlags({})).toBe(false);
    expect(hasLimitFlags({ trigger: undefined })).toBe(false);
    expect(hasLimitFlags({ "max-gas": "1" })).toBe(true);
  });
});
