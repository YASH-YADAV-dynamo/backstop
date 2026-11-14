/** Input validation and small encoders shared by the wallet UI. Pure; safe in client and server code. */
import { getAddress, isAddress, parseUnits, type Address } from "viem";

/** NEAR account id rules (nomicon): 2-64 chars, lowercase parts separated by `.`, `-` or `_`. */
const NEAR_ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isNearAccountId(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && NEAR_ACCOUNT_ID_RE.test(value);
}

/** A 64-hex implicit account (also what 1Click deposit addresses look like). */
export function isImplicitAccount(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Accepts all-lowercase or valid-checksum addresses; rejects a bad checksum. Returns the checksum form. */
export function parseEvmAddress(input: string): Parsed<Address> {
  const v = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return { ok: false, error: "An EVM address is 0x followed by 40 hex characters." };
  const mixed = v.slice(2) !== v.slice(2).toLowerCase() && v.slice(2) !== v.slice(2).toUpperCase();
  if (mixed && !isAddress(v, { strict: true })) {
    return { ok: false, error: "The capital letters in this address do not match its checksum. Copy it again from your wallet." };
  }
  return { ok: true, value: getAddress(v.toLowerCase()) };
}

/** Group a checksum address in fours for side-by-side comparison with a wallet prompt. */
export function groupAddress(address: string): string {
  const body = address.startsWith("0x") ? address.slice(2) : address;
  return `0x ${body.match(/.{1,4}/g)?.join(" ") ?? body}`;
}

/** Decimal string -> integer base units. Never goes through floats. */
export function parseDecimal(input: string, decimals: number, what: string): Parsed<bigint> {
  const v = input.trim();
  if (v === "") return { ok: false, error: `Enter ${what}.` };
  if (v.startsWith("-")) return { ok: false, error: `${what} cannot be negative.` };
  if (!/^\d*\.?\d*$/.test(v) || v === ".") return { ok: false, error: `${what} must be a plain number like 12.5.` };
  const frac = v.split(".")[1] ?? "";
  if (frac.length > decimals) return { ok: false, error: `${what} has at most ${decimals} decimal places.` };
  const value = parseUnits(v.startsWith(".") ? `0${v}` : v, decimals);
  if (value === 0n) return { ok: false, error: `${what} must be more than zero.` };
  return { ok: true, value };
}

export const parseUsdc = (input: string, what = "The amount") => parseDecimal(input, 6, what);

/** Health factor like "1.10" -> basis points 11000. */
export function parseHfBps(input: string, what: string): Parsed<number> {
  const r = parseDecimal(input, 4, what);
  if (!r.ok) return r;
  if (r.value > 100_0000n) return { ok: false, error: `${what} is unrealistically high.` };
  return { ok: true, value: Number(r.value) };
}

export type LimitsInput = {
  triggerHf: string;
  targetHf: string;
  maxPerRescue: string;
  dailyCap: string;
  cooldownSecs: string;
  maxFeeGwei: string;
  maxGasLimit: string;
};

export type LimitsJson = {
  trigger_hf_bps: number;
  target_hf_bps: number;
  max_per_rescue: string;
  daily_cap: string;
  cooldown_secs: string;
  max_fee_per_gas: string;
  max_gas_limit: string;
};

/** Mirrors `Limits::validate` in the contract, plus "trigger must be above 1.00" (below that is liquidation). */
export function parseLimits(input: LimitsInput): Parsed<LimitsJson> {
  const trigger = parseHfBps(input.triggerHf, "Trigger health factor");
  if (!trigger.ok) return trigger;
  const target = parseHfBps(input.targetHf, "Target health factor");
  if (!target.ok) return target;
  if (trigger.value <= 10_000) return { ok: false, error: "The trigger must be above 1.00; at 1.00 the loan is already being liquidated." };
  if (target.value <= trigger.value) return { ok: false, error: "The target health factor must be higher than the trigger." };
  const max = parseUsdc(input.maxPerRescue, "Max per rescue");
  if (!max.ok) return max;
  const cap = parseUsdc(input.dailyCap, "Daily cap");
  if (!cap.ok) return cap;
  if (max.value > cap.value) return { ok: false, error: "Max per rescue cannot be above the daily cap." };
  const cooldown = parseDecimal(input.cooldownSecs, 0, "Cooldown (seconds)");
  if (!cooldown.ok) return cooldown;
  const fee = parseDecimal(input.maxFeeGwei, 9, "Max fee (gwei)");
  if (!fee.ok) return fee;
  const gas = parseDecimal(input.maxGasLimit, 0, "Max gas limit");
  if (!gas.ok) return gas;
  return {
    ok: true,
    value: {
      trigger_hf_bps: trigger.value,
      target_hf_bps: target.value,
      max_per_rescue: max.value.toString(),
      daily_cap: cap.value.toString(),
      cooldown_secs: cooldown.value.toString(),
      max_fee_per_gas: fee.value.toString(),
      max_gas_limit: gas.value.toString(),
    },
  };
}

// --- base58 (Bitcoin alphabet): NEAR code hashes and public keys use it. -------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const ch of text) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error(`"${ch}" is not a base58 character`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  for (const ch of text) {
    if (ch !== "1") break;
    zeros++;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error("not a hex string");
  return Uint8Array.from(h.match(/../g)?.map((p) => parseInt(p, 16)) ?? []);
}

/** NEAR `code_hash` (base58 of sha256) for a 64-hex sha256. */
export const hexToNearCodeHash = (hex: string) => base58Encode(hexToBytes(hex));

/** Policy name suggested for an owner account (E.3): `.` -> `-`, cut to 32; implicit owners get `p-<16 hex>`. */
export function suggestPolicyName(owner: string): string {
  if (isImplicitAccount(owner)) return `p-${owner.slice(0, 16)}`;
  return owner.replace(/\./g, "-").replace(/_/g, "-").slice(0, 32).replace(/-+$/, "");
}
