/**
 * Shared types (the seams between packages). The shapes the packages exchange.
 * On-chain integers are bigint. Aave "Base" values are USD with 8 decimals.
 */

/** Aave v3 `getUserAccountData` for one user. */
export interface Position {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  /** basis points, e.g. 8300n = 83% */
  currentLiquidationThreshold: bigint;
  /** basis points */
  ltv: bigint;
  /** 1e18-scaled; type(uint256).max when there is no debt */
  healthFactor: bigint;
}

/** The user's limits as stored in the policy contract. USDC amounts use 6 decimals. */
export interface Limits {
  triggerHfBps: number;
  targetHfBps: number;
  maxPerRescue: bigint;
  dailyCap: bigint;
  cooldownSecs: number;
  maxFeePerGas: bigint;
  maxGasLimit: bigint;
  paused: boolean;
}

/** The last bridge the policy funded (`get_status().last_bridge`). */
export interface LastBridge {
  bridgeId: number;
  /** USDC (NEAR) paid to the 1Click deposit address, 6dp. */
  amountIn: bigint;
  /** USDC (Base) 1Click guaranteed to deliver, 6dp. */
  minAmountOut: bigint;
  /** 1Click deposit address (NEAR implicit account). */
  depositAddress: string;
  fundedAt: number;
}

/** Policy contract `get_status`. Times are unix seconds (0 = never). */
export interface PolicyStatus {
  spentToday: bigint;
  dayStart: number;
  lastRescueAt: number;
  rescueCount: number;
  remainingToday: bigint;
  cooldownEndsAt: number;
  /** Bridge budget: same limits as rescues, separate counters. */
  bridgeSpentToday: bigint;
  bridgeRemainingToday: bigint;
  lastBridgeAt: number;
  bridgeCooldownEndsAt: number;
  bridgeCount: number;
  lastApproveAt: number;
  lastBridge?: LastBridge;
}

export type RescueDecision =
  | { action: "none"; reason: string }
  | { action: "blocked"; reason: string }
  | { action: "rescue"; amount: bigint /* USDC 6dp */; uncapped: bigint; reason: string };

export interface RescueLinks {
  oneClickDeposit?: string;
  oneClickStatus?: string;
  nearRescueTx?: string;
  baseRepayTx?: string;
  baseFundsTx?: string;
}

export type RescueStatus = "success" | "failed" | "dry-run";

export interface RescueRecord {
  id: string;
  rescueId?: number;
  dryRun: boolean;
  /** ISO 8601 */
  triggeredAt: string;
  fundsArrivedAt?: string;
  repayMinedAt?: string;
  hfBefore: number;
  hfAfter?: number;
  /** USDC 6dp as an integer string */
  amount: string;
  status: RescueStatus;
  links: RescueLinks;
  error?: string;
  receipt?: string;
  /** Where `receipt` came from: NEAR AI Cloud, or the deterministic template fallback. */
  receiptSource?: "near-ai" | "template";
  /** The policy contract that signed the repay. */
  policyId?: string;
  /** The borrower whose debt was repaid (onBehalfOf), 0x address. */
  borrower?: string;
  /** 0x raw signed Base tx, saved before broadcast so a crash can resume it. */
  signedTx?: string;
  /** USDC (NEAR, 6dp) the policy paid into 1Click for this rescue, as an integer string. */
  bridgedIn?: string;
}
