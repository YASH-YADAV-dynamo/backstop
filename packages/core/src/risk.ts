/**
 * Risk engine. Pure functions: no network, no clock, no randomness.
 */
import type { Limits, PolicyStatus, Position, RescueDecision } from "./types.js";

const WAD = 10n ** 18n;
const BPS = 10_000n;
const USDC_UNIT = 10n ** 6n;
const MAX_UINT256 = 2n ** 256n - 1n;

/** 1e18-scaled health factor -> float. Aave reports type(uint256).max when there is no debt: returns Infinity. */
export function hfToNumber(hf: bigint): number {
  if (hf === MAX_UINT256) return Number.POSITIVE_INFINITY;
  const whole = hf / WAD;
  const frac = hf % WAD;
  return Number(whole) + Number(frac) / 1e18;
}

/** 1e18-scaled health factor -> basis points (rounded down). */
export function hfToBps(hf: bigint): bigint {
  return (hf * BPS) / WAD;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/**
 * USDC (6 decimals) to repay so the health factor reaches `targetHfBps`.
 *
 * Aave v3: HF = (totalCollateralBase * liqThresholdBps / 10000) / totalDebtBase,
 * all "Base" values are USD with 8 decimals.
 *
 * Repaying R (in base units) lowers debt. Target HF_t requires
 *   debt' = collateral * LT / HF_t
 * so
 *   R = debt - collateral * LT / HF_t            (clamped at >= 0)
 *   amountUsdc = ceil(R * 10^6 / usdcPriceBase)
 *
 * With HF_t = targetHfBps / 10000 and LT in bps the bps factors cancel:
 *   R = debt - collateral * LT_bps / targetHfBps
 *   amountUsdc = ceil((debt * targetHfBps - collateral * LT_bps) * 10^6 / (targetHfBps * usdcPriceBase))
 * Everything is bigint and the division is done once, rounding UP, so repaying `amountUsdc`
 * always reaches the target and repaying one unit (0.000001 USDC) less does not.
 *
 * @param usdcPriceBase USDC price from the Aave oracle (USD, 8 decimals), e.g. 99_990_000n.
 */
export function repayNeeded(p: Position, targetHfBps: number, usdcPriceBase: bigint): bigint {
  if (!Number.isInteger(targetHfBps) || targetHfBps <= 0) {
    throw new RangeError(`targetHfBps must be a positive integer (got ${targetHfBps}); e.g. 15000 for HF 1.5`);
  }
  if (usdcPriceBase <= 0n) {
    throw new RangeError(`usdcPriceBase must be > 0 (got ${usdcPriceBase}); read it from the Aave oracle`);
  }
  if (p.totalDebtBase <= 0n) return 0n;
  const t = BigInt(targetHfBps);
  const excess = p.totalDebtBase * t - p.totalCollateralBase * p.currentLiquidationThreshold;
  if (excess <= 0n) return 0n;
  return ceilDiv(excess * USDC_UNIT, t * usdcPriceBase);
}

export interface DecideOptions {
  /**
   * Replaces `limits.triggerHfBps` (the demo's `--trigger 3.0` = 30000). The repay target becomes
   * max(limits.targetHfBps, trigger) so a rescue on a healthy loan still has a non-zero amount.
   */
  triggerOverrideBps?: number;
}

const fmtHf = (bps: bigint | number): string => (Number(bps) / 10_000).toFixed(2);

/**
 * Decide whether to rescue, and how much. Order of checks:
 * no debt -> none; HF >= trigger -> none; paused -> blocked; cooldown -> blocked;
 * nothing left of the daily cap -> blocked; otherwise rescue min(needed, maxPerRescue, remainingToday).
 * The policy contract enforces the same limits again on-chain; this only avoids asking for a doomed rescue.
 */
export function decideRescue(
  p: Position,
  limits: Limits,
  status: PolicyStatus,
  nowSecs: number,
  usdcPriceBase: bigint,
  opts: DecideOptions = {},
): RescueDecision {
  if (p.totalDebtBase === 0n) return { action: "none", reason: "no debt: nothing to protect" };

  const triggerBps = opts.triggerOverrideBps ?? limits.triggerHfBps;
  const hfBps = hfToBps(p.healthFactor);
  const triggerLabel = opts.triggerOverrideBps === undefined ? "trigger" : "trigger override";
  if (hfBps >= BigInt(triggerBps)) {
    return {
      action: "none",
      reason: `healthy: HF ${fmtHf(hfBps)} >= ${triggerLabel} ${fmtHf(triggerBps)}`,
    };
  }

  if (limits.paused) return { action: "blocked", reason: "paused by owner: unpause the policy contract to allow rescues" };
  if (nowSecs < status.cooldownEndsAt) {
    return {
      action: "blocked",
      reason: `cooldown active for ${status.cooldownEndsAt - nowSecs}s more (ends at unix ${status.cooldownEndsAt})`,
    };
  }
  if (status.remainingToday <= 0n) {
    return { action: "blocked", reason: "daily cap used up: no rescue budget left today" };
  }

  const targetBps = Math.max(limits.targetHfBps, triggerBps);
  const uncapped = repayNeeded(p, targetBps, usdcPriceBase);
  if (uncapped === 0n) {
    return { action: "none", reason: `HF ${fmtHf(hfBps)} already at or above target ${fmtHf(targetBps)}` };
  }

  const base = `HF ${fmtHf(hfBps)} < ${triggerLabel} ${fmtHf(triggerBps)}; ${formatUsdc(uncapped)} USDC restores HF ${fmtHf(targetBps)}`;
  let amount = uncapped;
  let cap: string | undefined;
  if (limits.maxPerRescue < amount) {
    amount = limits.maxPerRescue;
    cap = `max per rescue ${formatUsdc(limits.maxPerRescue)} USDC`;
  }
  if (status.remainingToday < amount) {
    amount = status.remainingToday;
    cap = `remaining daily cap ${formatUsdc(status.remainingToday)} USDC`;
  }
  if (amount <= 0n) {
    return { action: "blocked", reason: "max per rescue is 0: raise it with set_limits to allow rescues" };
  }
  const reason = cap ? `${base}; capped by ${cap}` : base;
  return { action: "rescue", amount, uncapped, reason };
}

/** USDC 6dp integer -> "12.345678" (trailing zeros trimmed, at least 2 decimals). */
export function formatUsdc(amount: bigint): string {
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  const whole = abs / USDC_UNIT;
  const frac = (abs % USDC_UNIT).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${sign}${whole}.${frac}`;
}
