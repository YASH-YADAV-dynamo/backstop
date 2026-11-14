import { describe, expect, it } from "vitest";
import {
  decideRescue,
  formatUsdc,
  hfToNumber,
  repayNeeded,
  type Limits,
  type PolicyStatus,
  type Position,
} from "../src/index.js";

const WAD = 10n ** 18n;
const PRICE = 99_990_000n; // USDC = $0.9999 (8dp)

/** Build a position the way Aave reports it: HF = collateral * LT / 10000 / debt, 1e18-scaled. */
function position(collateralBase: bigint, debtBase: bigint, ltBps = 8_300n): Position {
  return {
    totalCollateralBase: collateralBase,
    totalDebtBase: debtBase,
    availableBorrowsBase: 0n,
    currentLiquidationThreshold: ltBps,
    ltv: 8_000n,
    healthFactor: debtBase === 0n ? 2n ** 256n - 1n : (collateralBase * ltBps * WAD) / 10_000n / debtBase,
  };
}

/** Exact HF check after repaying `amountUsdc`: HF' >= target  <=>  C*LT*1e6 >= t*(D*1e6 - amount*price). */
function reachesTarget(p: Position, amountUsdc: bigint, targetBps: number, price = PRICE): boolean {
  const debtAfterScaled = p.totalDebtBase * 10n ** 6n - amountUsdc * price;
  if (debtAfterScaled <= 0n) return true;
  return p.totalCollateralBase * p.currentLiquidationThreshold * 10n ** 6n >= BigInt(targetBps) * debtAfterScaled;
}

const limits: Limits = {
  triggerHfBps: 13_000,
  targetHfBps: 15_000,
  maxPerRescue: 10_000_000n, // 10 USDC
  dailyCap: 20_000_000n,
  cooldownSecs: 600,
  maxFeePerGas: 1_000_000_000n,
  maxGasLimit: 400_000n,
  paused: false,
};
const status: PolicyStatus = {
  spentToday: 0n,
  dayStart: 1_700_000_000,
  lastRescueAt: 0,
  rescueCount: 0,
  remainingToday: 20_000_000n,
  cooldownEndsAt: 0,
  bridgeSpentToday: 0n,
  bridgeRemainingToday: 20_000_000n,
  lastBridgeAt: 0,
  bridgeCooldownEndsAt: 0,
  bridgeCount: 0,
  lastApproveAt: 0,
};
const NOW = 1_700_000_500;

// $30 collateral, $20 debt, LT 83% -> HF 1.245 (below the 1.30 trigger)
const atRisk = position(3_000_000_000n, 2_000_000_000n);
// $30 collateral, $10 debt -> HF 2.49
const healthy = position(3_000_000_000n, 1_000_000_000n);

describe("hfToNumber", () => {
  it("converts a 1e18-scaled health factor", () => {
    expect(hfToNumber(1_245_000_000_000_000_000n)).toBeCloseTo(1.245, 12);
  });
  it("reports no debt (uint256 max) as Infinity", () => {
    expect(hfToNumber(2n ** 256n - 1n)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("repayNeeded", () => {
  it("repay amount restores target health factor", () => {
    for (const [c, d, t] of [
      [3_000_000_000n, 2_000_000_000n, 15_000],
      [3_000_000_000n, 2_000_000_000n, 30_000],
      [123_456_789_01n, 98_765_432_10n, 14_321],
      [500_000_001n, 400_000_007n, 10_501],
    ] as const) {
      const p = position(c, d);
      const amount = repayNeeded(p, t, PRICE);
      expect(amount).toBeGreaterThan(0n);
      expect(reachesTarget(p, amount, t)).toBe(true);
      expect(reachesTarget(p, amount - 1n, t)).toBe(false);
    }
  });

  it("repay amount matches the documented formula on a worked example", () => {
    // debt' = 30 * 0.83 / 1.5 = $16.60, so R = $3.40 -> 3.40 / 0.9999 = 3.400341 USDC (rounded up)
    expect(repayNeeded(atRisk, 15_000, PRICE)).toBe(3_400_341n);
  });

  it("is zero when already at or above target", () => {
    expect(repayNeeded(healthy, 15_000, PRICE)).toBe(0n);
  });

  it("is zero with no debt", () => {
    expect(repayNeeded(position(3_000_000_000n, 0n), 15_000, PRICE)).toBe(0n);
  });

  it("rejects a zero price or target", () => {
    expect(() => repayNeeded(atRisk, 15_000, 0n)).toThrow(/usdcPriceBase/);
    expect(() => repayNeeded(atRisk, 0, PRICE)).toThrow(/targetHfBps/);
  });
});

describe("decideRescue", () => {
  it("does nothing when healthy", () => {
    const d = decideRescue(healthy, limits, status, NOW, PRICE);
    expect(d.action).toBe("none");
    expect(d.reason).toMatch(/healthy/);
  });

  it("does nothing with no debt", () => {
    expect(decideRescue(position(3_000_000_000n, 0n), limits, status, NOW, PRICE).action).toBe("none");
  });

  it("rescues an at-risk loan with the amount that restores the target", () => {
    const d = decideRescue(atRisk, limits, status, NOW, PRICE);
    expect(d).toMatchObject({ action: "rescue", amount: 3_400_341n, uncapped: 3_400_341n });
    if (d.action === "rescue") expect(reachesTarget(atRisk, d.amount, limits.targetHfBps)).toBe(true);
  });

  it("blocked while paused", () => {
    const d = decideRescue(atRisk, { ...limits, paused: true }, status, NOW, PRICE);
    expect(d.action).toBe("blocked");
    expect(d.reason).toMatch(/paused/);
  });

  it("blocked in cooldown", () => {
    const d = decideRescue(atRisk, limits, { ...status, cooldownEndsAt: NOW + 30 }, NOW, PRICE);
    expect(d.action).toBe("blocked");
    expect(d.reason).toMatch(/cooldown active for 30s/);
  });

  it("not blocked once cooldown has ended", () => {
    expect(decideRescue(atRisk, limits, { ...status, cooldownEndsAt: NOW }, NOW, PRICE).action).toBe("rescue");
  });

  it("blocked when the daily cap is used up", () => {
    const d = decideRescue(atRisk, limits, { ...status, remainingToday: 0n, spentToday: 20_000_000n }, NOW, PRICE);
    expect(d.action).toBe("blocked");
    expect(d.reason).toMatch(/daily cap/);
  });

  it("never exceeds max per rescue", () => {
    const small = { ...limits, maxPerRescue: 1_000_000n };
    const d = decideRescue(atRisk, small, status, NOW, PRICE);
    expect(d).toMatchObject({ action: "rescue", amount: 1_000_000n, uncapped: 3_400_341n });
    expect(d.reason).toMatch(/capped by max per rescue 1.00 USDC/);
  });

  it("never exceeds remaining daily cap", () => {
    const d = decideRescue(atRisk, limits, { ...status, remainingToday: 2_500_000n }, NOW, PRICE);
    expect(d).toMatchObject({ action: "rescue", amount: 2_500_000n });
    expect(d.reason).toMatch(/capped by remaining daily cap 2.50 USDC/);
  });

  it("names the tighter cap when both apply", () => {
    const d = decideRescue(atRisk, { ...limits, maxPerRescue: 2_000_000n }, { ...status, remainingToday: 1_500_000n }, NOW, PRICE);
    expect(d).toMatchObject({ action: "rescue", amount: 1_500_000n });
    expect(d.reason).toMatch(/remaining daily cap/);
  });

  it("trigger override fires a rescue on a healthy loan", () => {
    const d = decideRescue(healthy, limits, status, NOW, PRICE, { triggerOverrideBps: 30_000 });
    expect(d.action).toBe("rescue");
    if (d.action !== "rescue") return;
    expect(d.reason).toMatch(/trigger override 3.00/);
    expect(reachesTarget(healthy, d.uncapped, 30_000)).toBe(true);
    expect(d.amount).toBeLessThanOrEqual(limits.maxPerRescue);
  });

  it("trigger override still respects pause", () => {
    expect(decideRescue(healthy, { ...limits, paused: true }, status, NOW, PRICE, { triggerOverrideBps: 30_000 }).action).toBe("blocked");
  });
});

describe("formatUsdc", () => {
  it("formats 6-decimal amounts", () => {
    expect(formatUsdc(2_012_702n)).toBe("2.012702");
    expect(formatUsdc(2_000_000n)).toBe("2.00");
    expect(formatUsdc(1_500_000n)).toBe("1.50");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(-2_500_000n)).toBe("-2.50");
  });
});
