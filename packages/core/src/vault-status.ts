/**
 * Bot status: the contract between the bot service and the web (design v3 1.2). One row per vault,
 * written by the bot every pass; the web shows "Protected" only when `checkedAt` is fresh, `state` is
 * "watching" and every readiness field is ok. Thresholds are computed here, never in the web.
 * Pure functions: no network, no clock.
 */

export type VaultState = "watching" | "rescuing" | "blocked" | "refused";
export type Readiness = "ok" | "low" | "empty";
/** usdc = the borrower has native-USDC variable debt; none = no debt; other = debt, but none of it is USDC variable. */
export type DebtKind = "usdc" | "none" | "other";

/** Machine-readable reason for a refused or blocked vault (null while watching). */
export type VaultReason =
  // refused at admission: the bot never calls these vaults
  | "UNREADABLE"
  | "NOT_ACTIVATED"
  | "HAS_ACCESS_KEYS"
  | "AGENT_MISMATCH"
  | "CODE_HASH_MISMATCH"
  | "CONFIG_MISMATCH"
  | "DUPLICATE_RESCUE_WALLET"
  // blocked: admitted, but a rescue cannot happen right now
  | "DEBT_NOT_USDC"
  | "PAUSED"
  | "NO_FUNDS"
  | "NO_GAS"
  | "LIMIT_REACHED"
  | "READ_FAILED"
  | "RESCUE_FAILED";

export interface VaultReadiness {
  /** vault (NEAR) + rescue wallet USDC vs max_per_rescue: empty = 0, low = below max_per_rescue. */
  funds: Readiness;
  /** rescue wallet ETH vs the bot's fee estimate for two repays: empty = 0, low = below it. */
  gas: Readiness;
  debt: DebtKind;
}

export interface VaultStatus {
  /** The vault (policy contract) account id. */
  policyId: string;
  /** Loan chain id; null when the vault could not be read at all. */
  chainId: number | null;
  /** ISO 8601 time the bot last checked this vault. */
  checkedAt: string;
  state: VaultState;
  reason: VaultReason | null;
  /** Human-readable detail for `reason` (never a key, never a full quote). */
  lastError: string | null;
  /** Borrower health factor, 4 decimals ("1.2345"); null when there is no debt or it was not read. */
  hf: string | null;
  /** USDC (6dp integer string) in the vault on NEAR plus in the rescue wallet. */
  usdc: string;
  /** USDC (6dp integer string) in the rescue wallet on the loan chain. */
  usdcWallet: string;
  /** Rescue wallet ETH in wei (integer string). */
  gasWei: string;
  /** Borrower's USDC variable debt (6dp integer string). */
  debt: string;
  readiness: VaultReadiness;
}

/** A status row is "fresh" for this long (design v3 1.2: "Protected" needs a check under 2 minutes old). */
export const STATUS_FRESH_MS = 120_000;

export function fundsReadiness(totalUsdc: bigint, maxPerRescue: bigint): Readiness {
  if (totalUsdc <= 0n) return "empty";
  return totalUsdc < maxPerRescue ? "low" : "ok";
}

/**
 * Wei two repays may cost: 2 x (gas_limit cap x fee per gas inside the contract's cap + 1.5 x the L1 data fee).
 * The same formula the agent uses before a repay (rescue.ts `txArgsFor`), at the contract's gas cap.
 */
export function twoRepaysGasWei(maxGasLimit: bigint, feePerGas: bigint, maxFeePerGasCap: bigint, l1Fee: bigint): bigint {
  const fee = feePerGas < maxFeePerGasCap ? feePerGas : maxFeePerGasCap;
  return 2n * (maxGasLimit * fee + (l1Fee * 150n) / 100n);
}

export function gasReadiness(gasWei: bigint, needWei: bigint): Readiness {
  if (gasWei <= 0n) return "empty";
  return gasWei < needWei ? "low" : "ok";
}

/** Aave totalDebtBase (any asset) + the USDC variable debt -> what kind of debt the loan has. */
export function debtKind(totalDebtBase: bigint, usdcVariableDebt: bigint): DebtKind {
  if (usdcVariableDebt > 0n) return "usdc";
  return totalDebtBase > 0n ? "other" : "none";
}

/** The web's rule: "Protected" only for a fresh, watching row with funds, gas and USDC debt all ok. */
export function isProtected(s: VaultStatus, now: Date): boolean {
  const age = now.getTime() - Date.parse(s.checkedAt);
  return (
    age >= 0 &&
    age < STATUS_FRESH_MS &&
    s.state === "watching" &&
    s.readiness.funds === "ok" &&
    s.readiness.gas === "ok" &&
    s.readiness.debt === "usdc"
  );
}
