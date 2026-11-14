/**
 * The dashboard snapshot as plain JSON (bigints are pre-formatted strings), so the same shape
 * flows from server components to client components and from /api/dashboard to the poller.
 */

/** A section either loaded, needs configuration (names the .env variable), or failed. */
export type Section<T> =
  | { state: "ok"; data: T }
  | { state: "unconfigured"; envVar: string; message: string }
  | { state: "error"; message: string };

/** The loan chain a policy protects, resolved on the server from the policy's `chain_id` (never a UI setting). */
export interface ChainView {
  id: number;
  key: "base" | "arbitrum";
  name: string;
  explorer: string;
}

export interface PolicyView {
  contractId: string;
  chain: ChainView;
  contractUrl: string;
  owner: string;
  agent: string;
  agentUrl: string;
  /** null until the policy is activated (v1.signer derives the loan-chain address on activation) */
  derivedAddress: string | null;
  derivedAddressUrl: string | null;
  /** The Aave borrower the policy repays for (checksum) */
  borrower: string;
  borrowerUrl: string;
  /** USDC held by the policy on NEAR, formatted */
  usdcInPolicy: string;
  nearInPolicy: string;
  checks: Array<{ id: string; label: string; state: "pass" | "fail" | "unknown"; detail: string }>;
  bridge: {
    count: number;
    spentToday: string;
    remainingToday: string;
    lastAt: number;
    last: { bridgeId: number; amountIn: string; minAmountOut: string; depositAddress: string; fundedAt: number } | null;
  };
  mpcContract: string;
  derivationPath: string;
  /** Service fee in bps of each bridged amount, and the NEAR account that receives it. */
  feeBps: number;
  feeAccount: string;
  limits: {
    triggerHf: number;
    targetHf: number;
    /** USDC, formatted */
    maxPerRescue: string;
    dailyCap: string;
    cooldownSecs: number;
    /** gwei, formatted */
    maxFeePerGasGwei: string;
    maxGasLimit: string;
    paused: boolean;
  };
  status: {
    spentToday: string;
    remainingToday: string;
    /** 0..100 share of the daily cap already used */
    spentPct: number;
    /** unix seconds; 0 = never */
    lastRescueAt: number;
    cooldownEndsAt: number;
    rescueCount: number;
  };
}

export interface PositionView {
  /** The Aave borrower (`on_behalf_of`): the account whose loan is shown. */
  address: string;
  /** null when the address has no debt (Aave reports type(uint256).max) */
  healthFactor: number | null;
  /** USD, formatted from Aave base units (8 decimals) */
  collateralUsd: string;
  debtUsd: string;
  availableBorrowUsd: string;
  /** percent, e.g. "83.00" */
  liquidationThresholdPct: string;
  ltvPct: string;
  /** balances of the policy's derived address on the loan chain (native USDC, ETH); null until the policy is activated */
  usdcBalance: string | null;
  ethBalance: string | null;
}

export interface RescueRow {
  id: string;
  dryRun: boolean;
  /** "2026-11-12 14:03 UTC" */
  date: string;
  hfBefore: string;
  hfAfter: string | null;
  amountUsdc: string;
  status: "success" | "failed" | "dry-run";
  /** `baseRepayTx` is the record field name; it is the repay transaction on the policy's loan chain. */
  links: { oneClickStatus?: string; nearRescueTx?: string; baseRepayTx?: string };
  error?: string;
  receipt?: { text: string; source: "NEAR AI" | "template" };
}

export interface DashboardSnapshot {
  fetchedAt: string;
  policy: Section<PolicyView>;
  position: Section<PositionView>;
  history: Section<RescueRow[]>;
}
