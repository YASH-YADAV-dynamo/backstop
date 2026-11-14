/**
 * Vault name commitment (factory-less vault creation). A new vault's account id is derived from what it
 * will be created with: `bkst-` + the first 20 hex chars of sha256(canonical encoding of owner, loan chain,
 * borrower, limits and a random salt) + `.near`. The web, the API and the bot each recompute it, so a
 * request whose fields were changed after the user's wallet signed does not match its own vault id and
 * is refused. Pure: no network, no clock; sha256 is WebCrypto (`globalThis.crypto.subtle`), so the same
 * code runs in the browser and in Node 22.
 */

/** `Limits` as the policy contract's JSON: U128 as decimal strings, u32 / u64 as numbers. */
export interface LimitsJson {
  trigger_hf_bps: number;
  target_hf_bps: number;
  /** USDC, 6 decimals */
  max_per_rescue: string;
  /** USDC, 6 decimals, per UTC day */
  daily_cap: string;
  cooldown_secs: number;
  /** wei */
  max_fee_per_gas: string;
  max_gas_limit: string;
}

export interface VaultCommitment {
  /** NEAR account that becomes the vault's owner (the wallet that paid for the account). */
  owner: string;
  /** Loan chain key from the registry ("base", "arbitrum"). */
  chainKey: string;
  /** EIP-55 checksummed 0x address holding the Aave loan. */
  borrower: string;
  limits: LimitsJson;
  /** 32 lowercase hex chars (16 random bytes), chosen by the browser once per create. */
  salt: string;
}

export const VAULT_NAME_PREFIX = "bkst-";
export const VAULT_NAME_HASH_CHARS = 20;
export const VAULT_NAME_SUFFIX = ".near";
const DOMAIN = "backstop-vault-v1";

const VAULT_NAME_RE = new RegExp(`^${VAULT_NAME_PREFIX}[0-9a-f]{${VAULT_NAME_HASH_CHARS}}\\${VAULT_NAME_SUFFIX}$`);
export const SALT_RE = /^[0-9a-f]{32}$/;
const UINT_STRING = /^(0|[1-9]\d*)$/;

/** True for an account id of the `bkst-<20 hex>.near` shape (says nothing about who made it). */
export const isVaultName = (id: string): boolean => VAULT_NAME_RE.test(id);

/** 16 random bytes as 32 lowercase hex chars, from the platform CSPRNG. */
export function randomSalt(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes);
}

const isUint = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * The limits as JSON with a fixed key order. Throws on a value whose JSON would not be canonical
 * (floats, negative numbers, leading zeros, extra or missing keys), so two encodings of one set of
 * limits can never give two names.
 */
export function canonicalLimits(l: LimitsJson): string {
  const keys = Object.keys(l).sort().join(",");
  if (keys !== "cooldown_secs,daily_cap,max_fee_per_gas,max_gas_limit,max_per_rescue,target_hf_bps,trigger_hf_bps") {
    throw new Error(`limits must have exactly the policy contract's seven keys, got: ${keys}`);
  }
  for (const k of ["trigger_hf_bps", "target_hf_bps", "cooldown_secs"] as const) {
    if (!isUint(l[k])) throw new Error(`limits.${k} must be a non-negative whole number`);
  }
  for (const k of ["max_per_rescue", "daily_cap", "max_fee_per_gas", "max_gas_limit"] as const) {
    if (typeof l[k] !== "string" || !UINT_STRING.test(l[k])) throw new Error(`limits.${k} must be a decimal integer string without leading zeros`);
  }
  return JSON.stringify({
    trigger_hf_bps: l.trigger_hf_bps,
    target_hf_bps: l.target_hf_bps,
    max_per_rescue: l.max_per_rescue,
    daily_cap: l.daily_cap,
    cooldown_secs: l.cooldown_secs,
    max_fee_per_gas: l.max_fee_per_gas,
    max_gas_limit: l.max_gas_limit,
  });
}

/** Domain tag, then each field as a 4-byte big-endian length and its UTF-8 bytes, in a fixed order. */
export function commitmentBytes(c: VaultCommitment): Uint8Array<ArrayBuffer> {
  if (!SALT_RE.test(c.salt)) throw new Error("salt must be 32 lowercase hex characters");
  if (!/^0x[0-9a-fA-F]{40}$/.test(c.borrower)) throw new Error("borrower must be a 0x address with 40 hex characters");
  const enc = new TextEncoder();
  const parts = [DOMAIN, c.owner, c.chainKey, c.borrower, canonicalLimits(c.limits), c.salt].map((s) => enc.encode(s));
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + 4 + p.length, 0)));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const p of parts) {
    view.setUint32(at, p.length);
    out.set(p, at + 4);
    at += 4 + p.length;
  }
  return out;
}

/** `bkst-<first 20 hex of sha256(commitmentBytes)>.near`. */
export async function vaultNameFor(c: VaultCommitment): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", commitmentBytes(c)));
  return `${VAULT_NAME_PREFIX}${toHex(digest).slice(0, VAULT_NAME_HASH_CHARS)}${VAULT_NAME_SUFFIX}`;
}

/** True when `vaultId` is exactly the name these fields commit to. */
export async function matchesCommitment(vaultId: string, c: VaultCommitment): Promise<boolean> {
  try {
    return (await vaultNameFor(c)) === vaultId;
  } catch {
    return false;
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
