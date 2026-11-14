/**
 * One pass of the agent: watch -> decide -> act. All I/O goes through
 * `AgentDeps` (live wiring in deps.ts), so the flow is tested end to end with fakes.
 *
 * Two addresses: the position is the **borrower's** (`config.onBehalfOf`); USDC, allowance, nonce
 * and ETH belong to the **derived address** (`config.baseAddress`), which signs and pays the repay.
 */
import { randomUUID } from "node:crypto";
import { keccak256, parseTransaction, type Address, type Hash, type Hex } from "viem";
import {
  decideRescue,
  formatUsdc,
  hfToNumber,
  type Limits,
  type PolicyStatus,
  type Position,
  type RescueDecision,
  type RescueLinks,
  type RescueRecord,
} from "@backstop/core";
import { loanChainById } from "@backstop/config";
import type { RescueStore } from "@backstop/db";
import { MIN_BRIDGE_AMOUNT, TERMINAL_STATUSES, type BridgeQuote } from "@backstop/mover";
import { expectedCall, pickTxParams, verifySignedTx } from "./checks.js";
import type { ActivePolicyConfig, BridgeFunded, PolicyConfig, RescueArgs, RescueSigned, TxArgs, TxKind } from "./policy.js";

export interface BridgeOutcome {
  status: string;
  statusUrl: string;
  /** Base tx that delivered the USDC, when 1Click reports one. */
  fundsTx?: string;
  refundReason?: string;
}

export interface AgentDeps {
  /** The policy contract this agent serves (POLICY_CONTRACT_ID). */
  policyId: string;
  now(): Date;
  log(line: string): void;
  readPolicy(): Promise<{ config: PolicyConfig; limits: Limits; status: PolicyStatus }>;
  readPosition(user: Address): Promise<Position>;
  usdcPrice(): Promise<bigint>;
  /** The borrower's Aave USDC variable debt, 6dp. */
  usdcDebt(user: Address): Promise<bigint>;
  usdcBalance(owner: Address): Promise<bigint>;
  usdcAllowance(owner: Address, spender: Address): Promise<bigint>;
  ethBalance(owner: Address): Promise<bigint>;
  /** USDC (NEAR, 6dp) held by the policy contract. */
  policyUsdc(): Promise<bigint>;
  nonce(address: Address): Promise<number>;
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  estimateGas(tx: { from: Address; to: Address; data: Hex }): Promise<bigint>;
  l1Fee(tx: { from: Address; to: Address; data: Hex }): Promise<bigint>;
  /** Dry 1Click quote (no deposit address): what `amountIn` NEAR USDC would deliver on Base. */
  dryQuote(amountIn: bigint, recipient: Address): Promise<{ minAmountOut: bigint; timeEstimate: number }>;
  /** Signed, verified 1Click quote with refundTo = the policy. */
  bridgeQuote(amountIn: bigint, recipient: Address): Promise<BridgeQuote>;
  /** `fund_bridge` on the policy with the agent key. */
  fundBridge(q: Pick<BridgeQuote, "canonical" | "signature">): Promise<{ nearTxHash: string; funded: BridgeFunded }>;
  /** Best-effort POST /v0/deposit/submit. */
  submitDeposit(nearTxHash: string, depositAddress: string): Promise<void>;
  /** Current 1Click status of a deposit address. */
  bridgeStatus(depositAddress: string): Promise<string>;
  /** Polls a deposit address until 1Click reports a terminal status. */
  pollBridge(depositAddress: string): Promise<BridgeOutcome>;
  callApprove(args: TxArgs): Promise<{ nearTxHash: string; signed: RescueSigned }>;
  callRescue(args: RescueArgs): Promise<{ nearTxHash: string; signed: RescueSigned }>;
  broadcast(signedTx: Hex): Promise<Hash>;
  receiptExists(hash: Hash): Promise<boolean>;
  waitForReceipt(hash: Hash): Promise<void>;
  /** Sleep used while waiting for bridged USDC to show up on Base. */
  sleep(ms: number): Promise<void>;
  store: RescueStore;
  writeReceipt(record: RescueRecord): Promise<{ text: string; source: "near-ai" | "template" }>;
  urls: { nearTx(hash: string): string; chainTx(hash: string): string };
  /** State kept across passes of one process. */
  session: {
    bridgeDisabled?: string;
    /** A contract-signed, verified approve whose broadcast failed (audit F8); re-sent while its nonce is current. */
    pendingApprove?: RescueSigned;
  };
}

export interface RunOptions {
  dryRun: boolean;
  /** Demo override for the trigger, e.g. 30000 = HF 3.0. */
  triggerOverrideBps?: number;
}

export interface RunResult {
  decision: RescueDecision;
  hf: number;
  record?: RescueRecord;
}

/** L1 data fee follows Ethereum L1 gas, which moves: keep 50% headroom. */
const L1_FEE_BUFFER_PCT = 150n;
/** After 1Click reports SUCCESS, how long to wait for the Base RPC to show the USDC. */
const FUNDS_VISIBLE_TIMEOUT_MS = 120_000;
const FUNDS_POLL_MS = 4_000;
/** Smallest repay worth a signature (0.1 USDC). */
const MIN_REPAY = 100_000n;
/** Mirrors the policy's APPROVE_MIN_INTERVAL_SECS. */
const APPROVE_INTERVAL_SECS = 3_600;
/** A bridge funded this recently is resumed (polled) instead of quoting a new one. */
const RESUME_WINDOW_SECS = 30 * 60;
/** Error text of a record whose rescue has started but not finished. */
export const IN_PROGRESS = "in progress";
/** Broadcast attempts per pass before giving up until the next pass (audit F8). */
export const BROADCAST_ATTEMPTS = 3;
const BROADCAST_RETRY_MS = 2_000;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const min = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));
const fmtHf = (hf: number) => (Number.isFinite(hf) ? hf.toFixed(4) : "no debt");
const iso = (secs: number) => new Date(secs * 1000).toISOString();

interface Pass {
  deps: AgentDeps;
  config: ActivePolicyConfig;
  limits: Limits;
  status: PolicyStatus;
  nowSecs: number;
  /** USDC to repay, already capped by the decision and the borrower's debt. */
  want: bigint;
  record: RescueRecord;
}

export async function runOnce(deps: AgentDeps, opts: RunOptions): Promise<RunResult> {
  const { config: read, limits, status } = await deps.readPolicy();
  if (read.baseAddress === null) throw new Error(`Policy ${deps.policyId} is not activated; run activate on it first.`);
  const config: ActivePolicyConfig = { ...read, baseAddress: read.baseAddress, chain: loanChainById(read.chainId) };
  const borrower = config.onBehalfOf;
  const [position, price, debt] = await Promise.all([deps.readPosition(borrower), deps.usdcPrice(), deps.usdcDebt(borrower)]);
  const hf = hfToNumber(position.healthFactor);
  const nowDate = deps.now();
  const nowSecs = Math.floor(nowDate.getTime() / 1000);
  let decision = decideRescue(position, limits, status, nowSecs, price, {
    ...(opts.triggerOverrideBps !== undefined && { triggerOverrideBps: opts.triggerOverrideBps }),
  });
  if (decision.action === "rescue" && debt === 0n) {
    decision = { action: "blocked", reason: "borrower has no USDC variable debt; Backstop v2 repays USDC debt only" };
  }
  deps.log(`Borrower ${borrower} HF ${fmtHf(hf)} -> ${decision.action}: ${decision.reason}`);
  if (decision.action !== "rescue") {
    if (!opts.dryRun && decision.action === "none" && !limits.paused) await proactiveApprove(deps, config, limits, status, nowSecs);
    return { decision, hf };
  }

  const want = min(decision.amount, debt);
  const record: RescueRecord = {
    id: randomUUID(),
    dryRun: opts.dryRun,
    triggeredAt: nowDate.toISOString(),
    hfBefore: hf,
    amount: want.toString(),
    status: opts.dryRun ? "dry-run" : "failed",
    links: {},
    policyId: deps.policyId,
    borrower,
    ...(!opts.dryRun && { error: IN_PROGRESS }),
  };
  await deps.store.add(record);
  const pass: Pass = { deps, config, limits, status, nowSecs, want, record };
  try {
    if (opts.dryRun) await dryRun(pass);
    else await live(pass);
  } catch (err) {
    record.status = "failed";
    record.error = errText(err);
    if (!opts.dryRun && record.signedTx && !record.links.baseRepayTx) {
      // Signed by the policy but not on Base yet: keep it resumable (audit F8, resumeSignedRepay).
      record.error = `${IN_PROGRESS}: signed repay not broadcast yet (${record.error}); retried next pass`;
    }
    deps.log(`Rescue failed: ${record.error}`);
  }
  const { id, ...rest } = record;
  await deps.store.update(id, rest);
  const receipt = await deps.writeReceipt(record);
  const saved = await deps.store.update(id, { receipt: receipt.text, receiptSource: receipt.source });
  deps.log(`Receipt (${receipt.source}): ${receipt.text}`);
  return { decision, hf, record: saved };
}

const addLinks = (record: RescueRecord, l: RescueLinks) => {
  record.links = { ...record.links, ...l };
};

/** Nonce, fees and gas for a tx from the derived address, inside the caps; checks ETH for gas. */
async function txArgsFor(deps: AgentDeps, limits: Limits, from: Address, call: { to: Address; data: Hex }): Promise<TxArgs> {
  const [nonce, fees, gasEstimate, l1Fee, eth] = await Promise.all([
    deps.nonce(from),
    deps.fees(),
    deps.estimateGas({ from, ...call }),
    deps.l1Fee({ from, ...call }),
    deps.ethBalance(from),
  ]);
  const tx = pickTxParams(fees, gasEstimate, limits);
  tx.notes.forEach((n) => deps.log(`Note: ${n}`));
  const maxCost = tx.gasLimit * tx.maxFeePerGas + (l1Fee * L1_FEE_BUFFER_PCT) / 100n;
  if (eth < maxCost) {
    throw new Error(`${from} holds ${eth} wei of ETH but the tx may cost up to ${maxCost} wei. Send a little ETH on Base to it and re-run.`);
  }
  return { evmNonce: nonce, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, gasLimit: tx.gasLimit };
}

/**
 * Broadcasts, retrying a flaky RPC up to BROADCAST_ATTEMPTS times (audit F8); a tx Base already
 * knows (crash/retry) is treated as sent. "nonce too low" without a receipt is final.
 */
async function broadcastOrFind(deps: AgentDeps, signed: RescueSigned): Promise<Hash> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await deps.broadcast(signed.signedTx);
    } catch (err) {
      const msg = errText(err);
      if (/already known/i.test(msg)) return signed.txHash;
      if (/nonce too low/i.test(msg)) {
        if (await deps.receiptExists(signed.txHash)) return signed.txHash;
        throw err;
      }
      if (attempt >= BROADCAST_ATTEMPTS) throw err;
      deps.log(`Broadcast attempt ${attempt} failed (${msg}); retrying.`);
      await deps.sleep(BROADCAST_RETRY_MS);
    }
  }
}

/**
 * Re-sends a verified signed approve whose broadcast failed earlier this run, if its nonce is still
 * the derived address's next nonce. Returns true when it was mined.
 */
async function rebroadcastPendingApprove(deps: AgentDeps, config: ActivePolicyConfig): Promise<boolean> {
  const pending = deps.session.pendingApprove;
  if (!pending) return false;
  const nonce = await deps.nonce(config.baseAddress);
  if (parseTransaction(pending.signedTx).nonce !== nonce) {
    deps.session.pendingApprove = undefined;
    return false;
  }
  deps.log("Re-broadcasting the approve signed earlier in this run...");
  const hash = await broadcastOrFind(deps, pending);
  await deps.waitForReceipt(hash);
  deps.session.pendingApprove = undefined;
  deps.log(`Approve mined: ${deps.urls.chainTx(hash)}`);
  return true;
}

async function approve(deps: AgentDeps, config: ActivePolicyConfig, limits: Limits): Promise<void> {
  const call = expectedCall("approve_pool", config, limits.dailyCap);
  const args = await txArgsFor(deps, limits, config.baseAddress, call);
  deps.log(`Calling approve_pool (USDC allowance ${formatUsdc(limits.dailyCap)} to the Aave Pool, nonce ${args.evmNonce})...`);
  const { nearTxHash, signed } = await deps.callApprove(args);
  await verifySignedTx(signed, { kind: "approve_pool", chainId: config.chainId, from: config.baseAddress, ...call, amount: limits.dailyCap, args });
  deps.session.pendingApprove = signed;
  const hash = await broadcastOrFind(deps, signed);
  await deps.waitForReceipt(hash);
  deps.session.pendingApprove = undefined;
  deps.log(`Approve mined: ${deps.urls.chainTx(hash)} (signed in ${deps.urls.nearTx(nearTxHash)}).`);
}

/** Idle pass: top the allowance up ahead of time so a rescue does not wait for an extra signature. */
async function proactiveApprove(deps: AgentDeps, config: ActivePolicyConfig, limits: Limits, status: PolicyStatus, nowSecs: number) {
  try {
    if (await rebroadcastPendingApprove(deps, config)) return;
    if (status.lastApproveAt > 0 && nowSecs < status.lastApproveAt + APPROVE_INTERVAL_SECS) return;
    const allowance = await deps.usdcAllowance(config.baseAddress, config.aavePool);
    if (allowance >= limits.maxPerRescue) return;
    deps.log(`Allowance ${formatUsdc(allowance)} USDC is below max_per_rescue; approving ahead of time.`);
    await approve(deps, config, limits);
  } catch (err) {
    deps.log(`Proactive approve skipped: ${errText(err)}`);
  }
}

/**
 * USDC to bridge for a shortfall: 1% (min 0.01 USDC) on top for fees, inside every limit. The policy
 * also pays its service fee (`feeBps` of the amount) from the same balance, so the amount is capped
 * so that amount + fee fits in what the policy holds.
 */
function bridgeAmount(shortfall: bigint, limits: Limits, status: PolicyStatus, policyUsdc: bigint, feeBps: number): bigint {
  const buffer = shortfall / 100n > 10_000n ? shortfall / 100n : 10_000n;
  const payable = (policyUsdc * 10_000n) / (10_000n + BigInt(feeBps));
  return min(shortfall + buffer, limits.maxPerRescue, status.bridgeRemainingToday, payable);
}

async function waitForUsdc(deps: AgentDeps, holder: Address, amount: bigint): Promise<void> {
  const deadline = deps.now().getTime() + FUNDS_VISIBLE_TIMEOUT_MS;
  for (;;) {
    const balance = await deps.usdcBalance(holder);
    if (balance >= amount) return;
    if (deps.now().getTime() > deadline) {
      throw new Error(
        `1Click reported SUCCESS but ${holder} holds ${formatUsdc(balance)} USDC (< ${formatUsdc(amount)}). ` +
          "Check the 1Click status link; the next pass uses whatever has arrived.",
      );
    }
    await deps.sleep(FUNDS_POLL_MS);
  }
}

/** Step 2 of D.4: get USDC to the derived address. Throws on any bridge problem (caller continues). */
async function ensureFunds(p: Pass, have: bigint): Promise<void> {
  const { deps, config, limits, status, nowSecs, want, record } = p;
  const derived = config.baseAddress;
  const lb = status.lastBridge;
  if (lb && nowSecs - lb.fundedAt < RESUME_WINDOW_SECS) {
    const current = await deps.bridgeStatus(lb.depositAddress);
    if (!(TERMINAL_STATUSES as readonly string[]).includes(current)) {
      deps.log(`Bridge #${lb.bridgeId} (${formatUsdc(lb.amountIn)} USDC) is still ${current} at 1Click; waiting for it instead of quoting again.`);
      const out = await deps.pollBridge(lb.depositAddress);
      addLinks(record, { oneClickStatus: out.statusUrl, ...(out.fundsTx && { baseFundsTx: out.fundsTx }) });
      if (out.status !== "SUCCESS") throw new Error(`Bridge #${lb.bridgeId} ended ${out.status}; its USDC returns to the policy on NEAR.`);
      await waitForUsdc(deps, derived, have + lb.minAmountOut);
      record.fundsArrivedAt = deps.now().toISOString();
      return;
    }
  }
  if (deps.session.bridgeDisabled) throw new Error(`bridging is off for this run (${deps.session.bridgeDisabled})`);
  if (nowSecs < status.bridgeCooldownEndsAt) throw new Error(`bridge cooldown until ${iso(status.bridgeCooldownEndsAt)}`);
  if (status.bridgeRemainingToday === 0n) throw new Error("today's bridge budget (daily_cap) is used up");
  const policyUsdc = await deps.policyUsdc();
  const amountIn = bridgeAmount(want - have, limits, status, policyUsdc, config.feeBps);
  if (amountIn < MIN_BRIDGE_AMOUNT) {
    throw new Error(`policy holds too little USDC to bridge (${formatUsdc(policyUsdc)} USDC on NEAR): deposit more`);
  }
  deps.log(`Derived address holds ${formatUsdc(have)} USDC; bridging ${formatUsdc(amountIn)} USDC from the policy via 1Click...`);
  const q = await deps.bridgeQuote(amountIn, derived);
  let sent: { nearTxHash: string; funded: BridgeFunded };
  try {
    sent = await deps.fundBridge(q);
  } catch (err) {
    // Our own checks passed but the contract refused: agent and contract disagree. Do not loop.
    if (/ERR_QUOTE_/.test(errText(err))) deps.session.bridgeDisabled = errText(err);
    throw err;
  }
  record.bridgedIn = sent.funded.amountIn.toString();
  addLinks(record, { oneClickDeposit: deps.urls.nearTx(sent.nearTxHash) });
  deps.log(`fund_bridge #${sent.funded.bridgeId} paid ${sent.funded.depositAddress}: ${deps.urls.nearTx(sent.nearTxHash)}`);
  await deps.submitDeposit(sent.nearTxHash, sent.funded.depositAddress).catch((err: unknown) => {
    deps.log(`1Click deposit/submit failed (${errText(err)}); relying on status polling.`);
  });
  const out = await deps.pollBridge(sent.funded.depositAddress);
  addLinks(record, { oneClickStatus: out.statusUrl, ...(out.fundsTx && { baseFundsTx: out.fundsTx }) });
  if (out.status !== "SUCCESS") {
    throw new Error(
      `1Click swap ended ${out.status}${out.refundReason ? ` (${out.refundReason})` : ""}; the USDC returns to the policy on NEAR.`,
    );
  }
  await waitForUsdc(deps, derived, have + sent.funded.minAmountOut);
  record.fundsArrivedAt = deps.now().toISOString();
}

async function live(p: Pass): Promise<void> {
  const { deps, config, limits, status, nowSecs, want, record } = p;
  const derived = config.baseAddress;

  // 1. Allowance: a repay without it reverts after the budget is spent.
  let allowance = await deps.usdcAllowance(derived, config.aavePool);
  if (allowance < want && (await rebroadcastPendingApprove(deps, config))) {
    allowance = await deps.usdcAllowance(derived, config.aavePool);
  }
  if (allowance < want) {
    if (status.lastApproveAt > 0 && nowSecs < status.lastApproveAt + APPROVE_INTERVAL_SECS) {
      throw new Error(
        `USDC allowance to the Aave Pool is ${formatUsdc(allowance)} (< ${formatUsdc(want)}) and approve_pool is ` +
          `rate-limited until ${iso(status.lastApproveAt + APPROVE_INTERVAL_SECS)}.`,
      );
    }
    await approve(deps, config, limits);
  }

  // 2. Funds on the derived address; a bridge problem never stops a repay with what is there.
  const have = await deps.usdcBalance(derived);
  let bridgeError: string | undefined;
  if (have < want) {
    try {
      await ensureFunds(p, have);
    } catch (err) {
      bridgeError = errText(err);
      deps.log(`Bridge: ${bridgeError}. Continuing with the USDC already on Base.`);
    }
  }
  const onBase = have < want ? await deps.usdcBalance(derived) : have;
  const amount = min(want, onBase);
  if (amount < MIN_REPAY) {
    throw new Error(
      `nothing to repay with on Base: ${derived} holds ${formatUsdc(onBase)} USDC${bridgeError ? `; bridge: ${bridgeError}` : ""}`,
    );
  }
  record.amount = amount.toString();
  if (amount < want) deps.log(`Partial repay: ${formatUsdc(amount)} of ${formatUsdc(want)} USDC.`);

  // 3. Gas, then 4. the policy builds repay(usdc, amount, 2, borrower) and has v1.signer sign it.
  const call = expectedCall("repay", config, amount);
  const args = await txArgsFor(deps, limits, derived, call);
  deps.log(`Calling rescue on the policy (amount ${formatUsdc(amount)} USDC, nonce ${args.evmNonce}, gas ${args.gasLimit})...`);
  const { nearTxHash, signed } = await deps.callRescue({ amount, ...args });
  record.rescueId = signed.rescueId;
  addLinks(record, { nearRescueTx: deps.urls.nearTx(nearTxHash) });
  await verifySignedTx(signed, { kind: "repay", chainId: config.chainId, from: derived, ...call, amount, args });
  record.signedTx = signed.signedTx;
  await deps.store.update(record.id, { signedTx: signed.signedTx, rescueId: signed.rescueId, links: record.links, amount: record.amount });
  deps.log(`Rescue #${signed.rescueId} signed by Chain Signatures: ${deps.urls.nearTx(nearTxHash)}`);

  // 5. Broadcast, wait, re-read the borrower's health factor.
  await finishRepay(deps, record, signed);
}

async function finishRepay(deps: AgentDeps, record: RescueRecord, signed: RescueSigned): Promise<void> {
  const hash = await broadcastOrFind(deps, signed);
  addLinks(record, { baseRepayTx: deps.urls.chainTx(hash) });
  deps.log(`Repay sent: ${deps.urls.chainTx(hash)}`);
  await deps.waitForReceipt(hash);
  record.repayMinedAt = deps.now().toISOString();
  const after = await deps.readPosition(record.borrower as Address);
  record.hfAfter = hfToNumber(after.healthFactor);
  record.status = "success";
  record.error = undefined;
  deps.log(`Repay mined. HF ${fmtHf(record.hfBefore)} -> ${fmtHf(record.hfAfter)}.`);
}

async function dryRun(p: Pass): Promise<void> {
  const { deps, config, limits, status, want } = p;
  const derived = config.baseAddress;
  const [have, allowance, policyUsdc] = await Promise.all([
    deps.usdcBalance(derived),
    deps.usdcAllowance(derived, config.aavePool),
    deps.policyUsdc(),
  ]);
  deps.log(
    `[dry-run] Derived address ${derived} holds ${formatUsdc(have)} USDC (allowance ${formatUsdc(allowance)}); ` +
      `the policy holds ${formatUsdc(policyUsdc)} USDC on NEAR; rescue wants ${formatUsdc(want)} USDC.`,
  );
  if (allowance < want) deps.log(`[dry-run] Would call approve_pool (approve ${formatUsdc(limits.dailyCap)} USDC to ${config.aavePool}).`);
  if (have < want) {
    const amountIn = bridgeAmount(want - have, limits, status, policyUsdc, config.feeBps);
    if (amountIn < MIN_BRIDGE_AMOUNT) {
      deps.log(`[dry-run] Would not bridge: only ${formatUsdc(amountIn)} USDC can be bridged within the limits and the policy balance.`);
    } else {
      try {
        const q = await deps.dryQuote(amountIn, derived);
        deps.log(
          `[dry-run] Would call fund_bridge with a signed 1Click quote: ${formatUsdc(amountIn)} USDC NEAR -> at least ` +
            `${formatUsdc(q.minAmountOut)} USDC to ${derived} (~${q.timeEstimate}s).`,
        );
      } catch (err) {
        deps.log(`[dry-run] 1Click dry quote failed: ${errText(err)}`);
      }
    }
  }
  const call = expectedCall("repay", config, want);
  const [nonce, fees] = await Promise.all([deps.nonce(derived), deps.fees()]);
  const gasEstimate = await deps.estimateGas({ from: derived, ...call }).catch(() => limits.maxGasLimit);
  const tx = pickTxParams(fees, gasEstimate, limits);
  deps.log(
    `[dry-run] Would call rescue(amount=${want}, evm_nonce=${nonce}, max_fee_per_gas=${tx.maxFeePerGas}, ` +
      `max_priority_fee_per_gas=${tx.maxPriorityFeePerGas}, gas_limit=${tx.gasLimit}); the policy would sign ` +
      `to=${call.to} value=0 data=${call.data} (repay for ${config.onBehalfOf}). Nothing was sent.`,
  );
}

/**
 * Recovery (D.5, audit F8; runs at startup and before every watch pass): the newest record that has a signed repay but no Base tx. If the derived
 * address's nonce still equals the tx nonce, re-verify and broadcast it; otherwise mark it failed.
 */
export async function resumeSignedRepay(deps: AgentDeps, config: ActivePolicyConfig): Promise<RescueRecord | undefined> {
  const records = await deps.store.list();
  const r = [...records]
    .reverse()
    .find((x) => x.policyId === deps.policyId && x.signedTx && !x.links.baseRepayTx && x.error?.startsWith(IN_PROGRESS));
  if (!r || !r.signedTx || !r.borrower) return undefined;
  const signedTx = r.signedTx as Hex;
  const tx = parseTransaction(signedTx);
  const nonce = await deps.nonce(config.baseAddress);
  if (tx.nonce !== nonce) {
    deps.log(`Rescue ${r.id}: signed repay (nonce ${tx.nonce}) was never broadcast and nonce ${nonce} is current; marking it failed.`);
    return deps.store.update(r.id, { error: `signed repay not broadcast before restart; nonce ${tx.nonce} no longer current` });
  }
  const amount = BigInt(r.amount);
  const signed: RescueSigned = { rescueId: r.rescueId ?? 0, kind: "repay" satisfies TxKind, amount, txHash: keccak256(signedTx), signedTx };
  const record: RescueRecord = structuredClone(r);
  let verified = false;
  try {
    await verifySignedTx(signed, {
      kind: "repay",
      chainId: config.chainId,
      from: config.baseAddress,
      ...expectedCall("repay", { ...config, onBehalfOf: r.borrower as Address }, amount),
      amount,
      args: {
        evmNonce: tx.nonce,
        maxFeePerGas: tx.maxFeePerGas ?? 0n,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n,
        gasLimit: tx.gas ?? 0n,
      },
    });
    verified = true;
    deps.log(`Rescue ${r.id}: broadcasting the repay signed earlier.`);
    await finishRepay(deps, record, signed);
  } catch (err) {
    record.status = "failed";
    record.error = errText(err);
    // Still unsent and still valid: stay resumable; a moved nonce marks it failed on a later pass.
    if (verified && !record.links.baseRepayTx) record.error = `${IN_PROGRESS}: broadcast failed again (${record.error})`;
    deps.log(`Rescue ${r.id} resume failed: ${record.error}`);
  }
  const { id, ...rest } = record;
  return deps.store.update(id, rest);
}
