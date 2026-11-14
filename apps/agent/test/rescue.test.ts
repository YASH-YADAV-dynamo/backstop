import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress, keccak256, parseTransaction } from "viem";
import { AAVE_BASE } from "@backstop/config";
import { encodeApprove, poolAbi } from "@backstop/lending-aave";
import { IN_PROGRESS, resumeSignedRepay, runOnce } from "../src/rescue.js";
import {
  BASE_ADDRESS,
  BORROWER,
  DEPOSIT_ADDRESS,
  NOW_SECS,
  POLICY_ID,
  config,
  contractApprove,
  contractSign,
  fakeDeps,
  limits,
  signTx,
} from "./helpers.js";

const live = { dryRun: false } as const;

describe("runOnce", () => {
  it("healthy loan: no rescue, nothing recorded", async () => {
    const f = fakeDeps({ debtUsd8: 10_00000000n }); // HF 1.6
    const r = await runOnce(f.deps, live);
    expect(r.decision.action).toBe("none");
    expect(f.store.records).toHaveLength(0);
    expect(f.calls.rescue).toHaveLength(0);
  });

  it("reads the position for the borrower and balances / nonce for the derived address", async () => {
    const f = fakeDeps({ usdc: 100_000_000n });
    const r = await runOnce(f.deps, live);
    expect(f.calls.positionFor.every((a) => a === BORROWER)).toBe(true);
    expect(f.calls.balanceFor.every((a) => a === BASE_ADDRESS)).toBe(true);
    expect(f.calls.nonceFor).toEqual([BASE_ADDRESS]);
    const tx = parseTransaction(f.calls.broadcast[0]!);
    const { args } = decodeFunctionData({ abi: poolAbi, data: tx.data! });
    expect(args![3]).toBe(BORROWER);
    expect(r.record).toMatchObject({ status: "success", borrower: BORROWER, policyId: POLICY_ID });
  });

  it("dry run sends nothing: no quote, no bridge, no approve, no rescue, no broadcast", async () => {
    const f = fakeDeps({ allowance: 0n });
    const r = await runOnce(f.deps, { dryRun: true });
    expect(r.decision.action).toBe("rescue");
    expect(f.calls).toMatchObject({ quote: [], fundBridge: 0, approve: [], rescue: [], broadcast: [] });
    expect(f.store.records).toHaveLength(1);
    expect(f.store.records[0]).toMatchObject({ status: "dry-run", dryRun: true, receipt: "Receipt." });
    expect(f.logs.join("\n")).toMatch(/Would call fund_bridge/);
    expect(f.logs.join("\n")).toMatch(/Would call approve_pool/);
  });

  it("trigger override rescues a loan the contract trigger calls healthy", async () => {
    const f = fakeDeps({ debtUsd8: 10_00000000n, usdc: 100_000_000n }); // HF 1.6 > trigger 1.1, < override 3.0
    const r = await runOnce(f.deps, { dryRun: false, triggerOverrideBps: 30_000 });
    expect(r.decision.action).toBe("rescue");
    // repay to HF 3.0: debt 10 -> 16/3, i.e. ceil(4.666...) USDC
    expect(f.calls.rescue[0]!.amount).toBe(4_666_667n);
  });

  it("trigger override is still capped by the contract's max_per_rescue", async () => {
    const f = fakeDeps({ debtUsd8: 12_00000000n, usdc: 100_000_000n });
    await runOnce(f.deps, { dryRun: false, triggerOverrideBps: 30_000 });
    expect(f.calls.rescue[0]!.amount).toBe(5_000_000n);
  });

  it("no USDC debt on the borrower: blocked, nothing signed", async () => {
    const f = fakeDeps();
    f.deps.usdcDebt = async () => 0n;
    const r = await runOnce(f.deps, live);
    expect(r.decision).toMatchObject({ action: "blocked", reason: expect.stringMatching(/USDC variable debt/) });
    expect(f.calls.rescue).toHaveLength(0);
  });

  it("no bridge when the Base balance suffices: broadcasts the contract-signed tx, records HF after", async () => {
    const f = fakeDeps({ usdc: 100_000_000n });
    const r = await runOnce(f.deps, live);
    expect(f.calls.quote).toHaveLength(0);
    expect(f.calls.fundBridge).toBe(0);
    expect(f.calls.rescue).toHaveLength(1);
    expect(f.calls.broadcast).toHaveLength(1);
    expect(r.record).toMatchObject({ status: "success", rescueId: 1 });
    expect(r.record!.error).toBeUndefined();
    expect(r.record!.signedTx).toBe(f.calls.broadcast[0]);
    expect(r.record!.hfAfter!).toBeGreaterThanOrEqual(1.3);
    expect(r.record!.links.nearRescueTx).toBe("near:NearTxHash111");
    expect(r.record!.links.baseRepayTx).toMatch(/^base:0x/);
  });

  it("bridges the shortfall plus a 1% (min 0.01 USDC) buffer from the policy via fund_bridge", async () => {
    const f = fakeDeps({ usdc: 1_000_000n });
    const r = await runOnce(f.deps, live);
    const want = BigInt(r.record!.amount);
    const shortfall = want - 1_000_000n;
    expect(f.calls.quote).toEqual([shortfall + shortfall / 100n]);
    expect(f.calls.fundBridge).toBe(1);
    expect(r.record).toMatchObject({ status: "success", bridgedIn: (shortfall + shortfall / 100n).toString() });
    expect(r.record!.fundsArrivedAt).toBeDefined();
    expect(r.record!.links).toMatchObject({ oneClickDeposit: "near:NearBridgeTx", oneClickStatus: "https://1click.example/status" });
  });

  it("bridge amount is capped by the policy's NEAR USDC; below 0.1 USDC it does not bridge", async () => {
    const f = fakeDeps({ usdc: 1_000_000n, policyUsdc: 50_000n });
    const r = await runOnce(f.deps, live);
    expect(f.calls.quote).toHaveLength(0);
    expect(f.logs.join("\n")).toMatch(/too little USDC.*deposit more/);
    expect(r.record).toMatchObject({ status: "success", amount: "1000000" });
  });

  it("resumes a non-terminal bridge instead of quoting again", async () => {
    const lastBridge = { bridgeId: 4, amountIn: 3_000_000n, minAmountOut: 2_990_000n, depositAddress: DEPOSIT_ADDRESS, fundedAt: NOW_SECS - 300 };
    const f = fakeDeps({
      usdc: 0n,
      status: { lastBridge, lastBridgeAt: NOW_SECS - 300, bridgeCooldownEndsAt: NOW_SECS + 300 },
      existingBridgeStatus: "PROCESSING",
    });
    const r = await runOnce(f.deps, live);
    expect(f.calls.quote).toHaveLength(0);
    expect(f.calls.fundBridge).toBe(0);
    expect(r.record).toMatchObject({ status: "success" });
    expect(f.logs.join("\n")).toMatch(/Bridge #4 .* still PROCESSING/);
  });

  it("partial repay with the USDC on Base when 1Click is down", async () => {
    const f = fakeDeps({ usdc: 1_000_000n });
    f.deps.bridgeQuote = async () => {
      throw new Error("1Click /v0/quote: 503");
    };
    const r = await runOnce(f.deps, live);
    expect(f.calls.rescue[0]!.amount).toBe(1_000_000n);
    expect(r.record).toMatchObject({ status: "success", amount: "1000000" });
    expect(f.logs.join("\n")).toMatch(/Partial repay/);
  });

  it("fails with 'nothing to repay' and the bridge error when 1Click is down and Base is empty", async () => {
    const f = fakeDeps({ usdc: 0n });
    f.deps.bridgeQuote = async () => {
      throw new Error("1Click /v0/quote: 503");
    };
    const r = await runOnce(f.deps, live);
    expect(r.record).toMatchObject({ status: "failed" });
    expect(r.record!.error).toMatch(/nothing to repay.*503/);
    expect(f.calls.rescue).toHaveLength(0);
  });

  it("a REFUNDED bridge still repays with what is on Base", async () => {
    const f = fakeDeps({ usdc: 1_000_000n, bridgeOutcome: "REFUNDED" });
    const r = await runOnce(f.deps, live);
    expect(r.record).toMatchObject({ status: "success", amount: "1000000" });
    expect(f.logs.join("\n")).toMatch(/REFUNDED.*returns to the policy/);
  });

  it("an ERR_QUOTE_* refusal from the contract stops bridging for the rest of the run", async () => {
    const f = fakeDeps({ usdc: 1_000_000n });
    f.deps.fundBridge = async () => {
      throw new Error("Smart contract panicked: ERR_QUOTE_STALE");
    };
    await runOnce(f.deps, live);
    expect(f.deps.session.bridgeDisabled).toMatch(/ERR_QUOTE_STALE/);
    await runOnce(f.deps, live);
    expect(f.calls.quote).toHaveLength(1);
  });

  it("bridge cooldown: no bridge, repays with what is on Base", async () => {
    const f = fakeDeps({ usdc: 1_000_000n, status: { bridgeCooldownEndsAt: NOW_SECS + 60 } });
    await runOnce(f.deps, live);
    expect(f.calls.quote).toHaveLength(0);
    expect(f.calls.rescue[0]!.amount).toBe(1_000_000n);
  });

  it("approve_pool path: low allowance -> approve_pool, verify, broadcast, then the repay", async () => {
    const f = fakeDeps({ usdc: 100_000_000n, allowance: 0n });
    const r = await runOnce(f.deps, live);
    expect(f.calls.approve).toHaveLength(1);
    expect(f.calls.broadcast).toHaveLength(2);
    expect(getAddress(parseTransaction(f.calls.broadcast[0]!).to!)).toBe(AAVE_BASE.usdc);
    expect(getAddress(parseTransaction(f.calls.broadcast[1]!).to!)).toBe(AAVE_BASE.pool);
    expect(r.record).toMatchObject({ status: "success" });
  });

  it("an approve_pool tx with a different spender is never broadcast", async () => {
    const f = fakeDeps({
      usdc: 100_000_000n,
      allowance: 0n,
      approveSign: async (a) => {
        const signedTx = await signTx(a, AAVE_BASE.usdc, encodeApprove(AAVE_BASE.weth, limits.dailyCap));
        return { ...(await contractApprove(a)), signedTx, txHash: keccak256(signedTx) };
      },
    });
    const r = await runOnce(f.deps, live);
    expect(r.record!.error).toMatch(/Not broadcasting/);
    expect(f.calls.broadcast).toHaveLength(0);
    expect(f.calls.rescue).toHaveLength(0);
  });

  it("low allowance while approve_pool is rate-limited fails before the budget is spent", async () => {
    const f = fakeDeps({ usdc: 100_000_000n, allowance: 0n, status: { lastApproveAt: NOW_SECS - 60 } });
    const r = await runOnce(f.deps, live);
    expect(r.record!.error).toMatch(/rate-limited/);
    expect(f.calls).toMatchObject({ approve: [], rescue: [], broadcast: [] });
  });

  it("idle pass tops the allowance up ahead of time", async () => {
    const f = fakeDeps({ debtUsd8: 10_00000000n, allowance: 0n });
    await runOnce(f.deps, live);
    expect(f.calls.approve).toHaveLength(1);
    expect(f.calls.rescue).toHaveLength(0);
  });

  it("rescue args stay inside the contract's fee and gas caps", async () => {
    const f = fakeDeps({ usdc: 100_000_000n, limits: { maxFeePerGas: 5_000_000n, maxGasLimit: 230_000n } });
    await runOnce(f.deps, live);
    const a = f.calls.rescue[0]!;
    expect(a.maxFeePerGas).toBe(5_000_000n);
    expect(a.maxPriorityFeePerGas).toBeLessThanOrEqual(a.maxFeePerGas);
    expect(a.gasLimit).toBe(230_000n);
    expect(a.evmNonce).toBe(7);
  });

  it("not enough ETH for gas fails before calling rescue", async () => {
    const f = fakeDeps({ usdc: 100_000_000n, eth: 1n });
    const r = await runOnce(f.deps, live);
    expect(r.record!.error).toMatch(/ETH/);
    expect(f.calls.rescue).toHaveLength(0);
  });

  it("a signed tx to anything but the Aave Pool is never broadcast", async () => {
    const f = fakeDeps({ usdc: 100_000_000n, sign: (a) => contractSign(a, { to: AAVE_BASE.usdc }) });
    const r = await runOnce(f.deps, live);
    expect(r.record).toMatchObject({ status: "failed" });
    expect(r.record!.error).toMatch(/Not broadcasting/);
    expect(f.calls.broadcast).toHaveLength(0);
  });

  it("a signed tx for a different amount is never broadcast", async () => {
    const f = fakeDeps({ usdc: 100_000_000n, sign: async (a) => ({ ...(await contractSign(a)), amount: a.amount + 1n }) });
    const r = await runOnce(f.deps, live);
    expect(r.record!.error).toMatch(/Not broadcasting/);
    expect(f.calls.broadcast).toHaveLength(0);
  });

  it("'already known' on broadcast counts as sent", async () => {
    const f = fakeDeps({ usdc: 100_000_000n });
    f.deps.broadcast = async () => {
      throw new Error("already known");
    };
    const r = await runOnce(f.deps, live);
    expect(r.record).toMatchObject({ status: "success" });
  });

  it("a flaky Base RPC is retried in the same pass (F8)", async () => {
    const f = fakeDeps({ usdc: 100_000_000n });
    const real = f.deps.broadcast;
    let failures = 2;
    f.deps.broadcast = async (tx) => {
      if (failures-- > 0) throw new Error("fetch failed");
      return real(tx);
    };
    const r = await runOnce(f.deps, live);
    expect(r.record).toMatchObject({ status: "success" });
    expect(f.calls.broadcast).toHaveLength(1);
  });

  it("a signed repay that could not be broadcast stays resumable and is sent on the next pass (F8)", async () => {
    const f = fakeDeps({ usdc: 100_000_000n });
    const real = f.deps.broadcast;
    let down = true;
    f.deps.broadcast = async (tx) => {
      if (down) throw new Error("fetch failed");
      return real(tx);
    };
    const r = await runOnce(f.deps, live);
    expect(r.record!.status).toBe("failed");
    expect(r.record!.error!.startsWith(IN_PROGRESS)).toBe(true);
    expect(r.record!.signedTx).toBeDefined();
    down = false;
    const resumed = await resumeSignedRepay(f.deps, config);
    expect(resumed).toMatchObject({ status: "success" });
    expect(f.calls.broadcast).toEqual([r.record!.signedTx]);
    expect(f.calls.rescue).toHaveLength(1);
  });

  it("a signed approve whose broadcast failed is re-sent next pass instead of waiting out the hour (F8)", async () => {
    const f = fakeDeps({ usdc: 100_000_000n, allowance: 0n });
    const real = f.deps.broadcast;
    let down = true;
    f.deps.broadcast = async (tx) => {
      if (down) throw new Error("fetch failed");
      return real(tx);
    };
    const first = await runOnce(f.deps, live);
    expect(first.record!.status).toBe("failed");
    expect(f.calls.approve).toHaveLength(1);
    expect(f.deps.session.pendingApprove).toBeDefined();
    // The policy now reports the approve as used (rate-limited for an hour).
    const read = f.deps.readPolicy;
    f.deps.readPolicy = async () => {
      const p = await read();
      return { ...p, status: { ...p.status, lastApproveAt: NOW_SECS } };
    };
    down = false;
    const second = await runOnce(f.deps, live);
    expect(second.record).toMatchObject({ status: "success" });
    expect(f.calls.approve).toHaveLength(1);
    expect(getAddress(parseTransaction(f.calls.broadcast[0]!).to!)).toBe(AAVE_BASE.usdc);
    expect(f.deps.session.pendingApprove).toBeUndefined();
  });

  it("a failed contract call is recorded as failed with the error and a receipt", async () => {
    const f = fakeDeps({ usdc: 100_000_000n });
    f.deps.callRescue = async () => {
      throw new Error("NEAR tx failed: ERR_COOLDOWN");
    };
    const r = await runOnce(f.deps, live);
    expect(r.record).toMatchObject({ status: "failed", error: "NEAR tx failed: ERR_COOLDOWN", receipt: "Receipt." });
    expect(f.calls.broadcast).toHaveLength(0);
  });
});

describe("resumeSignedRepay", () => {
  async function signedButNotSent(nonce: number) {
    const f = fakeDeps({ usdc: 100_000_000n });
    const signed = await contractSign({ amount: 2_000_000n, evmNonce: nonce, maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 1_000_000n, gasLimit: 240_000n });
    await f.store.add({
      id: "r1",
      dryRun: false,
      triggeredAt: "2026-11-13T11:59:00.000Z",
      hfBefore: 1.05,
      amount: "2000000",
      status: "failed",
      error: IN_PROGRESS,
      links: { nearRescueTx: "near:x" },
      policyId: POLICY_ID,
      borrower: BORROWER,
      rescueId: 1,
      signedTx: signed.signedTx,
    });
    return f;
  }

  it("broadcasts a signed repay whose nonce is still current", async () => {
    const f = await signedButNotSent(7);
    const r = await resumeSignedRepay(f.deps, config);
    expect(f.calls.broadcast).toHaveLength(1);
    expect(r).toMatchObject({ status: "success" });
    expect(r!.links.baseRepayTx).toMatch(/^base:0x/);
  });

  it("marks it failed when the nonce moved on", async () => {
    const f = await signedButNotSent(6);
    const r = await resumeSignedRepay(f.deps, config);
    expect(f.calls.broadcast).toHaveLength(0);
    expect(r!.error).toMatch(/no longer current/);
  });
});
