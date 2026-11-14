import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AAVE_ARBITRUM, AAVE_BASE, BASE, ONE_CLICK, loanChainByKey } from "@backstop/config";
import { encodeApprove, encodeRepay } from "@backstop/lending-aave";
import { assertConfigMatches, expectedCall, pickTxParams, verifySignedTx, type ExpectedTx } from "../src/checks.js";
import type { RescueArgs } from "../src/policy.js";
import { BASE_ADDRESS, BORROWER, config, contractApprove, contractSign, limits, signTx } from "./helpers.js";

const expected = { chainsigAddress: BASE_ADDRESS, mpcViewAddress: BASE_ADDRESS, accessKeyCount: 0, agentAccountId: "agent.near" };

describe("assertConfigMatches", () => {
  it("accepts a keyless, activated v2 policy deployed for this agent", () => {
    expect(assertConfigMatches(config, expected).baseAddress).toBe(BASE_ADDRESS);
  });
  it("refuses when the policy account has access keys", () => {
    expect(() => assertConfigMatches(config, { ...expected, accessKeyCount: 2, allowKeyedRehearsal: true })).toThrow(/exactly one key/);
    expect(() => assertConfigMatches(config, { ...expected, accessKeyCount: 1, allowKeyedRehearsal: true })).not.toThrow();
    expect(() => assertConfigMatches(config, { ...expected, accessKeyCount: 1 })).toThrow(
      /has 1 access key\(s\); a full-access key bypasses every limit/,
    );
  });
  it("refuses a policy that is not activated", () => {
    expect(() => assertConfigMatches({ ...config, baseAddress: null }, expected)).toThrow(/run activate/);
  });
  it("refuses when base_address differs from either derivation", () => {
    expect(() => assertConfigMatches(config, { ...expected, chainsigAddress: AAVE_BASE.weth })).toThrow(/chainsig.js derives/);
    expect(() => assertConfigMatches(config, { ...expected, mpcViewAddress: AAVE_BASE.weth })).toThrow(/derived_public_key/);
  });
  it("refuses a v1 policy or a rotated 1Click key", () => {
    expect(() => assertConfigMatches({ ...config, version: "1.0.0" }, expected)).toThrow(/version/);
    expect(() => assertConfigMatches({ ...config, bridgeSignerPk: "ed25519:x" }, expected)).toThrow(/set_bridge_signer/);
  });
  it("refuses wrong pool, USDC, bridge asset, derivation path or chain", () => {
    expect(() => assertConfigMatches({ ...config, aavePool: AAVE_BASE.weth }, expected)).toThrow(/aave_pool/);
    expect(() => assertConfigMatches({ ...config, usdcNear: "usdc.near" }, expected)).toThrow(/usdc_near/);
    expect(() => assertConfigMatches({ ...config, bridgeDestAsset: "nep141:x" }, expected)).toThrow(/bridge_dest_asset/);
    expect(() => assertConfigMatches({ ...config, derivationPath: "x" }, expected)).toThrow(/derivation_path/);
  });
  it("refuses a policy whose chain_id is not a supported loan chain, and says which are", () => {
    expect(() => assertConfigMatches({ ...config, chainId: 1 }, expected)).toThrow(/Chain id 1 is not supported.*Base \(8453\), Arbitrum One \(42161\)/);
  });
  const arbConfig = { ...config, chainId: 42161, chain: loanChainByKey("arbitrum"), aavePool: AAVE_ARBITRUM.pool, usdcBase: AAVE_ARBITRUM.usdc, bridgeDestAsset: ONE_CLICK.expectedUsdcArbitrumAssetId };
  it("accepts a correct Arbitrum policy (Arbitrum pool, native USDCn, arb asset)", () => {
    expect(assertConfigMatches(arbConfig, expected).chain.key).toBe("arbitrum");
  });
  it("rejects an Arbitrum policy that carries the Base pool, Base USDC or Base bridge asset", () => {
    expect(() => assertConfigMatches({ ...arbConfig, aavePool: AAVE_BASE.pool }, expected)).toThrow(/aave_pool.*Arbitrum One Aave v3 Pool/);
    expect(() => assertConfigMatches({ ...arbConfig, usdcBase: AAVE_BASE.usdc }, expected)).toThrow(/usdc_base.*native USDC on Arbitrum One/);
    expect(() => assertConfigMatches({ ...arbConfig, usdcBase: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8" }, expected)).toThrow(/usdc_base/);
    expect(() => assertConfigMatches({ ...arbConfig, bridgeDestAsset: ONE_CLICK.expectedUsdcBaseAssetId }, expected)).toThrow(/bridge_dest_asset/);
  });
  it("rejects a Base policy that carries the Arbitrum pool", () => {
    expect(() => assertConfigMatches({ ...config, aavePool: AAVE_ARBITRUM.pool }, expected)).toThrow(/aave_pool.*Base Aave v3 Pool/);
  });
  it("refuses when the contract's agent is not AGENT_ACCOUNT_ID; a dry run skips that check", () => {
    expect(() => assertConfigMatches({ ...config, agent: "other.near" }, expected)).toThrow(/set_agent/);
    const { agentAccountId: _, ...dry } = expected;
    expect(() => assertConfigMatches({ ...config, agent: "other.near" }, dry)).not.toThrow();
  });
});

describe("pickTxParams", () => {
  const caps = { maxFeePerGas: 1_000_000_000n, maxGasLimit: 400_000n };
  it("adds 20% gas headroom", () => {
    expect(pickTxParams({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }, 200_000n, caps).gasLimit).toBe(240_000n);
  });
  it("clamps the fee to the contract cap and keeps priority fee <= max fee", () => {
    const t = pickTxParams({ maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 3_000_000_000n }, 100_000n, caps);
    expect(t.maxFeePerGas).toBe(caps.maxFeePerGas);
    expect(t.maxPriorityFeePerGas).toBe(caps.maxFeePerGas);
    expect(t.notes).toHaveLength(1);
  });
  it("clamps buffered gas to the cap when the raw estimate fits", () => {
    expect(pickTxParams({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, 390_000n, caps).gasLimit).toBe(400_000n);
  });
  it("refuses when the tx needs more gas than the cap", () => {
    expect(() => pickTxParams({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, 400_001n, caps)).toThrow(/set_limits/);
  });
});

describe("verifySignedTx", () => {
  const args: RescueArgs = {
    amount: 2_000_000n,
    evmNonce: 3,
    maxFeePerGas: limits.maxFeePerGas,
    maxPriorityFeePerGas: 1_000_000n,
    gasLimit: 300_000n,
  };
  const repay: ExpectedTx = { kind: "repay", chainId: BASE.chainId, from: BASE_ADDRESS, ...expectedCall("repay", config, args.amount), amount: args.amount, args };
  const approve: ExpectedTx = {
    kind: "approve_pool",
    chainId: BASE.chainId,
    from: BASE_ADDRESS,
    ...expectedCall("approve_pool", config, limits.dailyCap),
    amount: limits.dailyCap,
    args,
  };

  it("repay: accepts repay(usdc, amount, 2, borrower) to the Pool", async () => {
    await expect(verifySignedTx(await contractSign(args), repay)).resolves.toBeUndefined();
  });
  it("repay: rejects a repay on behalf of the derived address instead of the borrower", async () => {
    const s = await contractSign(args, { data: encodeRepay(AAVE_BASE.usdc, args.amount, BASE_ADDRESS) });
    await expect(verifySignedTx(s, repay)).rejects.toThrow(/calldata/);
  });
  it("approve_pool: accepts approve(pool, daily_cap) on Base USDC", async () => {
    await expect(verifySignedTx(await contractApprove(args), approve)).resolves.toBeUndefined();
  });
  it("approve_pool: rejects another spender or amount", async () => {
    const tx = await signTx(args, AAVE_BASE.usdc, encodeApprove(AAVE_BASE.weth, limits.dailyCap));
    const s = { ...(await contractApprove(args)), signedTx: tx, txHash: keccak256(tx) };
    await expect(verifySignedTx(s, approve)).rejects.toThrow(/calldata/);
    await expect(verifySignedTx(await contractApprove(args, limits.dailyCap + 1n), approve)).rejects.toThrow(/amount/);
  });
  it("rejects a result whose kind does not match the call", async () => {
    await expect(verifySignedTx(await contractApprove(args), repay)).rejects.toThrow(/kind is approve_pool/);
  });
  it("rejects a tx_hash that is not the hash of signed_tx", async () => {
    const s = await contractSign(args);
    await expect(verifySignedTx({ ...s, txHash: `0x${"11".repeat(32)}` }, repay)).rejects.toThrow(/tx_hash/);
  });
  it("rejects a nonce other than the one requested", async () => {
    await expect(verifySignedTx(await contractSign({ ...args, evmNonce: 4 }), repay)).rejects.toThrow(/nonce/);
  });
  it("rejects a signature that does not recover to the derived address", async () => {
    const other = privateKeyToAccount(`0x${"42".repeat(32)}`);
    const signedTx = await other.signTransaction({
      type: "eip1559",
      chainId: BASE.chainId,
      nonce: args.evmNonce,
      to: AAVE_BASE.pool,
      value: 0n,
      data: encodeRepay(AAVE_BASE.usdc, args.amount, BORROWER),
      maxFeePerGas: args.maxFeePerGas,
      maxPriorityFeePerGas: args.maxPriorityFeePerGas,
      gas: args.gasLimit,
    });
    const s = { rescueId: 1, kind: "repay" as const, amount: args.amount, txHash: keccak256(signedTx), signedTx };
    await expect(verifySignedTx(s, repay)).rejects.toThrow(/recovers/);
  });
});
