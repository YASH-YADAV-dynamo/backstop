/** Test doubles: an in-memory store, a local key standing in for MPC, and fake AgentDeps. */
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AAVE_BASE, BASE, NEAR, ONE_CLICK, POLICY, loanChainById } from "@backstop/config";
import type { Limits, PolicyStatus, Position, RescueRecord } from "@backstop/core";
import { applyPatch, type RescuePatch, type RescueStore } from "@backstop/db";
import { encodeApprove, encodeRepay } from "@backstop/lending-aave";
import type { BridgeQuote } from "@backstop/mover";
import type { ActivePolicyConfig, BridgeFunded, RescueArgs, RescueSigned, TxArgs } from "../src/policy.js";
import type { AgentDeps, BridgeOutcome } from "../src/rescue.js";

/** Stands in for the MPC-derived key of the policy contract (never used on a real chain). */
export const mpcKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
export const BASE_ADDRESS = mpcKey.address;
/** The user's own Base wallet: holds the loan, never signs anything for Backstop. */
export const BORROWER: Address = getAddress("0x000000000000000000000000000000000000bEEF");
export const POLICY_ID = "alice.backstop.near";
export const DEPOSIT_ADDRESS = "ab".repeat(32);

export const config: ActivePolicyConfig = {
  version: POLICY.version,
  owner: "alice.near",
  agent: "agent.near",
  baseAddress: BASE_ADDRESS,
  onBehalfOf: BORROWER,
  chainId: BASE.chainId,
  chain: loanChainById(BASE.chainId),
  aavePool: AAVE_BASE.pool,
  usdcBase: AAVE_BASE.usdc,
  usdcNear: NEAR.usdcToken,
  bridgeDestAsset: ONE_CLICK.expectedUsdcBaseAssetId,
  bridgeSignerPk: ONE_CLICK.managerPublicKey,
  mpcContract: NEAR.mpcContract,
  derivationPath: NEAR.derivationPath,
  feeAccount: "fees.backstop.near",
  feeBps: 10,
};

export const limits: Limits = {
  triggerHfBps: 11_000,
  targetHfBps: 13_000,
  maxPerRescue: 5_000_000n,
  dailyCap: 10_000_000n,
  cooldownSecs: 600,
  maxFeePerGas: 1_000_000_000n,
  maxGasLimit: 400_000n,
  paused: false,
};

export const status: PolicyStatus = {
  spentToday: 0n,
  dayStart: 0,
  lastRescueAt: 0,
  rescueCount: 0,
  remainingToday: 10_000_000n,
  cooldownEndsAt: 0,
  bridgeSpentToday: 0n,
  bridgeRemainingToday: 10_000_000n,
  lastBridgeAt: 0,
  bridgeCooldownEndsAt: 0,
  bridgeCount: 0,
  lastApproveAt: 0,
};

export const NOW = new Date("2026-11-13T12:00:00Z");
export const NOW_SECS = Math.floor(NOW.getTime() / 1000);

const WAD = 10n ** 18n;
/** $20 collateral at 80% LT; debt sets the HF: 16 / debt. */
export function position(debtUsd8: bigint): Position {
  const collateral = 20_00000000n;
  const lt = 8_000n;
  return {
    totalCollateralBase: collateral,
    totalDebtBase: debtUsd8,
    availableBorrowsBase: 0n,
    currentLiquidationThreshold: lt,
    ltv: 7_500n,
    healthFactor: debtUsd8 === 0n ? 2n ** 256n - 1n : (collateral * lt * WAD) / (debtUsd8 * 10_000n),
  };
}

/** Signs with the stand-in MPC key exactly the tx `to`/`data`, with the agent's nonce and fees. */
export async function signTx(args: TxArgs, to: Address, data: Hex): Promise<Hex> {
  return mpcKey.signTransaction({
    type: "eip1559",
    chainId: BASE.chainId,
    nonce: args.evmNonce,
    to,
    value: 0n,
    data,
    maxFeePerGas: args.maxFeePerGas,
    maxPriorityFeePerGas: args.maxPriorityFeePerGas,
    gas: args.gasLimit,
  });
}

/** What the real contract does for `rescue`: repay(usdc, amount, 2, borrower), signed by MPC. */
export async function contractSign(args: RescueArgs, overrides: { to?: Address; data?: Hex } = {}): Promise<RescueSigned> {
  const signedTx = await signTx(args, overrides.to ?? AAVE_BASE.pool, overrides.data ?? encodeRepay(AAVE_BASE.usdc, args.amount, BORROWER));
  return { rescueId: 1, kind: "repay", amount: args.amount, txHash: keccak256(signedTx), signedTx };
}

/** What the real contract does for `approve_pool`: approve(pool, daily_cap) on Base USDC. */
export async function contractApprove(args: TxArgs, cap: bigint = limits.dailyCap): Promise<RescueSigned> {
  const signedTx = await signTx(args, AAVE_BASE.usdc, encodeApprove(AAVE_BASE.pool, cap));
  return { rescueId: 1, kind: "approve_pool", amount: cap, txHash: keccak256(signedTx), signedTx };
}

export class MemoryStore implements RescueStore {
  records: RescueRecord[] = [];
  async add(r: RescueRecord) {
    this.records.push(structuredClone(r));
  }
  async update(id: string, patch: RescuePatch) {
    const i = this.records.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`unknown ${id}`);
    this.records[i] = applyPatch(this.records[i]!, patch);
    return structuredClone(this.records[i]!);
  }
  async list() {
    return structuredClone(this.records);
  }
  async close() {}
}

export interface Fake {
  deps: AgentDeps;
  store: MemoryStore;
  calls: {
    quote: bigint[];
    fundBridge: number;
    approve: TxArgs[];
    rescue: RescueArgs[];
    broadcast: Hex[];
    /** Addresses each read was made for. */
    positionFor: Address[];
    balanceFor: Address[];
    nonceFor: Address[];
  };
  /** Derived-address USDC, borrower debt (8dp USD), policy USDC on NEAR, allowance. */
  state: { usdc: bigint; debt: bigint; policyUsdc: bigint; allowance: bigint };
  logs: string[];
}

export interface FakeOptions {
  debtUsd8?: bigint;
  /** USDC already on the derived address. */
  usdc?: bigint;
  allowance?: bigint;
  eth?: bigint;
  policyUsdc?: bigint;
  limits?: Partial<Limits>;
  status?: Partial<PolicyStatus>;
  sign?: (a: RescueArgs) => Promise<RescueSigned>;
  approveSign?: (a: TxArgs) => Promise<RescueSigned>;
  /** Final 1Click status for a bridge (default SUCCESS). */
  bridgeOutcome?: string;
  /** Status 1Click reports for an existing deposit address (resume). */
  existingBridgeStatus?: string;
}

export function fakeDeps(opts: FakeOptions = {}): Fake {
  const store = new MemoryStore();
  const calls: Fake["calls"] = {
    quote: [],
    fundBridge: 0,
    approve: [],
    rescue: [],
    broadcast: [],
    positionFor: [],
    balanceFor: [],
    nonceFor: [],
  };
  const state = {
    usdc: opts.usdc ?? 0n,
    debt: opts.debtUsd8 ?? 15_00000000n,
    policyUsdc: opts.policyUsdc ?? 20_000_000n,
    allowance: opts.allowance ?? 2n ** 256n - 1n,
  };
  const logs: string[] = [];
  let lastAmount = 0n;
  let pendingIn = 0n;
  let approving = false;
  const outcome = (): BridgeOutcome => ({
    status: opts.bridgeOutcome ?? "SUCCESS",
    statusUrl: "https://1click.example/status",
    ...((opts.bridgeOutcome ?? "SUCCESS") === "SUCCESS" && { fundsTx: "https://basescan.org/tx/0xfunds" }),
  });
  const deps: AgentDeps = {
    policyId: POLICY_ID,
    now: () => NOW,
    log: (l) => logs.push(l),
    readPolicy: async () => ({ config, limits: { ...limits, ...opts.limits }, status: { ...status, ...opts.status } }),
    readPosition: async (user) => {
      calls.positionFor.push(user);
      return position(state.debt);
    },
    usdcPrice: async () => 1_00000000n,
    usdcDebt: async () => state.debt / 100n,
    usdcBalance: async (o) => {
      calls.balanceFor.push(o);
      return state.usdc;
    },
    usdcAllowance: async () => state.allowance,
    ethBalance: async () => opts.eth ?? 10n ** 16n,
    policyUsdc: async () => state.policyUsdc,
    nonce: async (a) => {
      calls.nonceFor.push(a);
      return 7;
    },
    fees: async () => ({ maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    estimateGas: async () => 200_000n,
    l1Fee: async () => 1_000_000_000n,
    dryQuote: async (amountIn) => ({ minAmountOut: amountIn - 10_000n, timeEstimate: 20 }),
    bridgeQuote: async (amountIn): Promise<BridgeQuote> => {
      calls.quote.push(amountIn);
      return {
        canonical: "{}",
        signature: "ed25519:sig",
        amountIn,
        minAmountOut: amountIn - 10_000n,
        depositAddress: DEPOSIT_ADDRESS,
        deadlineSecs: NOW_SECS + 1800,
        timeEstimate: 20,
        correlationId: "c",
      };
    },
    fundBridge: async () => {
      calls.fundBridge += 1;
      const amountIn = calls.quote.at(-1)!;
      pendingIn = amountIn;
      state.policyUsdc -= amountIn;
      const funded: BridgeFunded = { bridgeId: 1, amountIn, minAmountOut: amountIn - 10_000n, depositAddress: DEPOSIT_ADDRESS, quoteHash: "00".repeat(32) };
      return { nearTxHash: "NearBridgeTx", funded };
    },
    submitDeposit: async () => {},
    bridgeStatus: async () => opts.existingBridgeStatus ?? "SUCCESS",
    pollBridge: async () => {
      const o = outcome();
      // the swap delivers the input minus 0.01 USDC of fees; a resumed bridge delivers its last_bridge
      const delivered = pendingIn > 0n ? pendingIn - 10_000n : (opts.status?.lastBridge?.minAmountOut ?? 0n);
      if (o.status === "SUCCESS") state.usdc += delivered;
      else state.policyUsdc += pendingIn;
      return o;
    },
    callApprove: async (a) => {
      calls.approve.push(a);
      approving = true;
      return { nearTxHash: "NearApproveTx", signed: await (opts.approveSign ?? contractApprove)(a) };
    },
    callRescue: async (a) => {
      calls.rescue.push(a);
      lastAmount = a.amount;
      return { nearTxHash: "NearTxHash111", signed: await (opts.sign ?? contractSign)(a) };
    },
    broadcast: async (tx) => {
      calls.broadcast.push(tx);
      return keccak256(tx);
    },
    receiptExists: async () => false,
    waitForReceipt: async () => {
      if (approving) {
        approving = false;
        state.allowance = (opts.limits?.dailyCap ?? limits.dailyCap);
        return;
      }
      // repaying USDC (6dp) at $1 lowers debt (8dp) by amount * 100
      state.usdc -= lastAmount;
      state.debt -= lastAmount * 100n;
      state.allowance -= lastAmount;
    },
    sleep: async () => {},
    store,
    writeReceipt: async () => ({ text: "Receipt.", source: "template" }),
    urls: { nearTx: (h) => `near:${h}`, chainTx: (h) => `base:${h}` },
    session: {},
  };
  return { deps, store, calls, state, logs };
}
