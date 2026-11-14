/**
 * Builds the per-vault status row (design v3 1.2) from what the service read this pass. Pure: the
 * service passes the clock. Readiness thresholds live in @backstop/core so the web invents none.
 */
import {
  debtKind,
  fundsReadiness,
  gasReadiness,
  hfToBps,
  type DebtKind,
  type Position,
  type VaultReason,
  type VaultStatus,
} from "@backstop/core";
import type { Limits } from "@backstop/core";
import type { ActivePolicyConfig } from "./policy.js";

/** One vault's loan-chain reads (one Multicall3 batch per chain). */
export interface LoanRead {
  /** The borrower's Aave getUserAccountData. */
  position: Position;
  /** The borrower's native-USDC variable debt, 6dp. */
  usdcDebt: bigint;
  /** Rescue wallet USDC, 6dp. */
  walletUsdc: bigint;
  /** Rescue wallet USDC allowance to the Aave Pool. */
  allowance: bigint;
  /** Rescue wallet ETH, wei. */
  gasWei: bigint;
}

/** Why the last action on a vault did not save it (cleared once it is healthy or a rescue succeeds). */
export interface Outcome {
  reason: VaultReason;
  message: string;
}

export interface WatchInput {
  policyId: string;
  config: ActivePolicyConfig;
  limits: Limits;
  /** USDC (NEAR, 6dp) held by the vault, from the last NEAR read. */
  usdcVault: bigint;
  /** This pass's read, an Error when it failed, plus the last good one (amounts shown on failure). */
  read: LoanRead | Error;
  lastGood?: LoanRead | undefined;
  /** Wei two repays may cost on this chain right now (`twoRepaysGasWei`). */
  gasNeedWei: bigint;
  rescuing: boolean;
  outcome?: Outcome | undefined;
  checkedAt: string;
}

const MAX_UINT256 = 2n ** 256n - 1n;
const fmtHf = (hf: bigint): string | null => (hf === MAX_UINT256 ? null : hf.toString());

/** The borrower is below the vault's trigger (only meaningful with debt). */
export function belowTrigger(position: Position, triggerHfBps: number): boolean {
  return position.totalDebtBase > 0n && hfToBps(position.healthFactor) < BigInt(triggerHfBps);
}

/** Within `marginBps` above the trigger: the service refreshes the vault's NEAR state every pass. */
export function nearTrigger(position: Position, triggerHfBps: number, marginBps = 1_000): boolean {
  return position.totalDebtBase > 0n && hfToBps(position.healthFactor) < BigInt(triggerHfBps + marginBps);
}

export function watchStatus(i: WatchInput): VaultStatus {
  const r = i.read instanceof Error ? i.lastGood : i.read;
  const debt: DebtKind = r ? debtKind(r.position.totalDebtBase, r.usdcDebt) : "none";
  const total = i.usdcVault + (r?.walletUsdc ?? 0n);
  const readiness = {
    funds: fundsReadiness(total, i.limits.maxPerRescue),
    gas: gasReadiness(r?.gasWei ?? 0n, i.gasNeedWei),
    debt,
  };
  let state: VaultStatus["state"] = "watching";
  let reason: VaultReason | null = null;
  let lastError: string | null = null;
  const block = (code: VaultReason, msg: string) => {
    state = "blocked";
    reason = code;
    lastError = msg.slice(0, 1000);
  };
  if (i.read instanceof Error) block("READ_FAILED", `loan-chain read failed: ${i.read.message}`);
  else if (i.rescuing) state = "rescuing";
  else if (i.limits.paused) block("PAUSED", "the owner paused the vault; unpause it to allow rescues");
  else if (debt === "other") block("DEBT_NOT_USDC", "the loan has no native-USDC variable debt; Backstop repays only that debt");
  else if (debt === "usdc" && readiness.funds === "empty") block("NO_FUNDS", "no USDC in the vault or the rescue wallet; add USDC");
  else if (debt === "usdc" && readiness.gas === "empty") block("NO_GAS", "the rescue wallet has no ETH for gas; send a little ETH to it");
  else if (i.outcome) block(i.outcome.reason, i.outcome.message);
  return {
    policyId: i.policyId,
    chainId: i.config.chainId,
    checkedAt: i.checkedAt,
    state,
    reason,
    lastError,
    hf: r ? fmtHf(r.position.healthFactor) : null,
    usdc: total.toString(),
    usdcWallet: (r?.walletUsdc ?? 0n).toString(),
    gasWei: (r?.gasWei ?? 0n).toString(),
    debt: (r?.usdcDebt ?? 0n).toString(),
    readiness,
  };
}

export function refusedStatus(policyId: string, chainId: number | null, reason: VaultReason, message: string, checkedAt: string): VaultStatus {
  return {
    policyId,
    chainId,
    checkedAt,
    state: "refused",
    reason,
    lastError: message.slice(0, 1000),
    hf: null,
    usdc: "0",
    usdcWallet: "0",
    gasWei: "0",
    debt: "0",
    readiness: { funds: "empty", gas: "empty", debt: "none" },
  };
}
