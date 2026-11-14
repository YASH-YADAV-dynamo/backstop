/**
 * Limit flags shared by deploy-policy and policy-admin: parse human units into the policy
 * contract's `Limits` JSON and validate them exactly like `Limits::validate` in
 * contracts/policy/src/limits.rs, so a bad value fails here instead of in a mainnet tx.
 * Pure: no network, no env.
 */
import { formatUnits } from "viem";
import type { LimitsJson } from "@backstop/core";

/** `Limits` as the contract's JSON (defined once in packages/core, next to the vault name commitment). */
export type { LimitsJson };

/** Option specs for node:util parseArgs (all strings; parsed by limitsFromFlags). */
export const LIMIT_OPTIONS = {
  trigger: { type: "string" },
  target: { type: "string" },
  "max-per-rescue": { type: "string" },
  "daily-cap": { type: "string" },
  cooldown: { type: "string" },
  "max-fee-gwei": { type: "string" },
  "max-gas": { type: "string" },
} as const;

export type LimitFlag = keyof typeof LIMIT_OPTIONS;
export type LimitFlags = Partial<Record<LimitFlag, string | undefined>>;

export const LIMIT_FLAGS_HELP =
  "--trigger <HF, e.g. 1.1> --target <HF, e.g. 1.3> --max-per-rescue <USDC> --daily-cap <USDC> " +
  "--cooldown <seconds> --max-fee-gwei <gwei> --max-gas <gas units>";

/** Defaults for a first deploy: trigger HF 1.1, target 1.3, 5 USDC per rescue, 10 USDC/day, 10 min, 1 gwei, 400k gas. */
export const DEFAULT_LIMITS: LimitsJson = {
  trigger_hf_bps: 11_000,
  target_hf_bps: 13_000,
  max_per_rescue: "5000000",
  daily_cap: "10000000",
  cooldown_secs: 600,
  max_fee_per_gas: "1000000000",
  max_gas_limit: "400000",
};

const USDC_DECIMALS = 6;
const HF_BPS_DECIMALS = 4;
const GWEI_DECIMALS = 9;
const U32_MAX = 4_294_967_295n;
const U64_MAX = 2n ** 64n - 1n;
const U128_MAX = 2n ** 128n - 1n;

/**
 * Exact decimal -> integer in the smallest unit. Rejects more fractional digits than the unit
 * has (instead of silently rounding), signs, exponents and empty strings.
 */
export function decimalToUnits(flag: string, value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`--${flag} must be a non-negative decimal number, got "${value}".`);
  const [, whole = "", frac = ""] = m;
  if (frac.length > decimals) {
    throw new Error(`--${flag} allows at most ${decimals} decimal places, got "${value}".`);
  }
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

function inRange(flag: string, v: bigint, max: bigint): bigint {
  if (v > max) throw new Error(`--${flag} is too large (max ${max} in contract units).`);
  return v;
}

/** Throws with the contract's own error code if the contract would reject these limits. */
export function validateLimits(l: LimitsJson): void {
  const fail = (code: string, what: string) => {
    throw new Error(`${code}: ${what}. The contract would reject these limits; fix the flag and re-run.`);
  };
  if (l.target_hf_bps <= l.trigger_hf_bps) {
    fail("ERR_TARGET_HF_NOT_ABOVE_TRIGGER", `--target (${hfOf(l.target_hf_bps)}) must be above --trigger (${hfOf(l.trigger_hf_bps)})`);
  }
  const maxPer = BigInt(l.max_per_rescue);
  const cap = BigInt(l.daily_cap);
  if (maxPer === 0n) fail("ERR_MAX_PER_RESCUE_ZERO", "--max-per-rescue must be > 0");
  if (maxPer > cap) {
    fail("ERR_MAX_PER_RESCUE_ABOVE_DAILY_CAP", `--max-per-rescue (${usdcOf(maxPer)}) must be <= --daily-cap (${usdcOf(cap)})`);
  }
  if (BigInt(l.max_fee_per_gas) === 0n) fail("ERR_MAX_FEE_PER_GAS_ZERO", "--max-fee-gwei must be > 0");
  if (BigInt(l.max_gas_limit) === 0n) fail("ERR_MAX_GAS_LIMIT_ZERO", "--max-gas must be > 0");
  if (l.cooldown_secs === 0) fail("ERR_COOLDOWN_ZERO", "--cooldown must be > 0 seconds");
}

/**
 * Applies the given flags on top of `base` (DEFAULT_LIMITS for a deploy, the on-chain limits
 * for set-limits) and validates the result. Flags left out keep the base value.
 */
export function limitsFromFlags(flags: LimitFlags, base: LimitsJson): LimitsJson {
  const out: LimitsJson = { ...base };
  if (flags.trigger !== undefined) {
    out.trigger_hf_bps = Number(inRange("trigger", decimalToUnits("trigger", flags.trigger, HF_BPS_DECIMALS), U32_MAX));
  }
  if (flags.target !== undefined) {
    out.target_hf_bps = Number(inRange("target", decimalToUnits("target", flags.target, HF_BPS_DECIMALS), U32_MAX));
  }
  if (flags["max-per-rescue"] !== undefined) {
    out.max_per_rescue = inRange("max-per-rescue", decimalToUnits("max-per-rescue", flags["max-per-rescue"], USDC_DECIMALS), U128_MAX).toString();
  }
  if (flags["daily-cap"] !== undefined) {
    out.daily_cap = inRange("daily-cap", decimalToUnits("daily-cap", flags["daily-cap"], USDC_DECIMALS), U128_MAX).toString();
  }
  if (flags.cooldown !== undefined) {
    const secs = inRange("cooldown", decimalToUnits("cooldown", flags.cooldown, 0), U64_MAX);
    if (secs > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`--cooldown is too large (max ${Number.MAX_SAFE_INTEGER} seconds).`);
    out.cooldown_secs = Number(secs);
  }
  if (flags["max-fee-gwei"] !== undefined) {
    out.max_fee_per_gas = inRange("max-fee-gwei", decimalToUnits("max-fee-gwei", flags["max-fee-gwei"], GWEI_DECIMALS), U128_MAX).toString();
  }
  if (flags["max-gas"] !== undefined) {
    out.max_gas_limit = inRange("max-gas", decimalToUnits("max-gas", flags["max-gas"], 0), U128_MAX).toString();
  }
  validateLimits(out);
  return out;
}

/** True if any limit flag was given. */
export const hasLimitFlags = (flags: LimitFlags): boolean =>
  (Object.keys(LIMIT_OPTIONS) as LimitFlag[]).some((k) => flags[k] !== undefined);

const uintString = (v: unknown): v is string | number =>
  (typeof v === "string" && /^\d+$/.test(v)) || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);

/** `get_limits` view -> LimitsJson (drops `paused`). Throws if the shape is not the policy contract's. */
export function limitsFromView(raw: unknown): LimitsJson {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const keys: (keyof LimitsJson)[] = [
    "trigger_hf_bps",
    "target_hf_bps",
    "max_per_rescue",
    "daily_cap",
    "cooldown_secs",
    "max_fee_per_gas",
    "max_gas_limit",
  ];
  const bad = keys.filter((k) => !uintString(r[k]));
  if (bad.length) {
    throw new Error(
      `get_limits returned an unexpected shape (bad or missing: ${bad.join(", ")}). Check that POLICY_CONTRACT_ID runs contracts/policy.`,
    );
  }
  return {
    trigger_hf_bps: Number(r.trigger_hf_bps),
    target_hf_bps: Number(r.target_hf_bps),
    max_per_rescue: String(r.max_per_rescue),
    daily_cap: String(r.daily_cap),
    cooldown_secs: Number(r.cooldown_secs),
    max_fee_per_gas: String(r.max_fee_per_gas),
    max_gas_limit: String(r.max_gas_limit),
  };
}

const hfOf = (bps: number) => formatUnits(BigInt(bps), HF_BPS_DECIMALS);
const usdcOf = (units: bigint) => `${formatUnits(units, USDC_DECIMALS)} USDC`;

/** Human-readable lines, one per limit. */
export function describeLimits(l: LimitsJson): string[] {
  return [
    `trigger HF:      ${hfOf(l.trigger_hf_bps)} (${l.trigger_hf_bps} bps)`,
    `target HF:       ${hfOf(l.target_hf_bps)} (${l.target_hf_bps} bps)`,
    `max per rescue:  ${usdcOf(BigInt(l.max_per_rescue))}`,
    `daily cap:       ${usdcOf(BigInt(l.daily_cap))} per UTC day`,
    `cooldown:        ${l.cooldown_secs} s`,
    `max fee per gas: ${formatUnits(BigInt(l.max_fee_per_gas), GWEI_DECIMALS)} gwei`,
    `max gas limit:   ${l.max_gas_limit}`,
  ];
}
