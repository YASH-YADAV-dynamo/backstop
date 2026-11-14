/**
 * Pure safety checks the agent runs before it acts. The policy contract enforces the limits on-chain;
 * these catch misconfiguration early and re-verify what the contract returns (defense in depth).
 */
import {
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
} from "viem";
import { FEE, NEAR, ONE_CLICK, POLICY, loanChainById } from "@backstop/config";
import type { Limits } from "@backstop/core";
import { encodeApprove, encodeRepay } from "@backstop/lending-aave";
import type { ActivePolicyConfig, PolicyConfig, RescueSigned, TxArgs, TxKind } from "./policy.js";

export interface ExpectedConfig {
  /** Base address chainsig.js derives locally for (POLICY_CONTRACT_ID, NEAR.derivationPath). */
  chainsigAddress: Address;
  /** The same, from the `v1.signer.derived_public_key` view. */
  mpcViewAddress: Address;
  /** Number of access keys on the policy account (`view_access_key_list`). */
  accessKeyCount: number;
  /**
   * `--allow-keyed-rehearsal` (audit F2, design D24): accept exactly ONE access key, the temporary
   * rehearsal key added by `deploy-policy --rehearsal`. Never more than one.
   */
  allowKeyedRehearsal?: boolean;
  /** AGENT_ACCOUNT_ID; omitted in dry runs, which never call the policy. */
  agentAccountId?: string;
}

/**
 * Throws one error listing every way the deployed policy differs from what
 * this agent expects; returns the config narrowed to an activated policy.
 */
export function assertConfigMatches(config: PolicyConfig, expected: ExpectedConfig): ActivePolicyConfig {
  const problems: string[] = [];
  const same = (a: string, b: string) => getAddress(a) === getAddress(b);
  const chain = loanChainById(config.chainId);
  if (config.version !== POLICY.version) problems.push(`version is ${config.version}, expected ${POLICY.version}`);
  if (!same(config.aavePool, chain.aave.pool)) problems.push(`aave_pool is ${config.aavePool}, expected the ${chain.name} Aave v3 Pool ${chain.aave.pool}`);
  if (!same(config.usdcBase, chain.aave.usdc)) problems.push(`usdc_base is ${config.usdcBase}, expected native USDC on ${chain.name} ${chain.aave.usdc}`);
  if (config.mpcContract !== NEAR.mpcContract) problems.push(`mpc_contract is ${config.mpcContract}, expected ${NEAR.mpcContract}`);
  if (config.derivationPath !== NEAR.derivationPath) {
    problems.push(`derivation_path is "${config.derivationPath}", expected "${NEAR.derivationPath}"`);
  }
  if (config.feeBps > FEE.maxBps) problems.push(`fee_bps is ${config.feeBps}, above the ${FEE.maxBps} bps cap this agent accepts`);
  if (config.usdcNear !== NEAR.usdcToken) problems.push(`usdc_near is ${config.usdcNear}, expected ${NEAR.usdcToken}`);
  if (config.bridgeDestAsset !== chain.usdcAssetId) {
    problems.push(`bridge_dest_asset is ${config.bridgeDestAsset}, expected ${chain.usdcAssetId}`);
  }
  if (config.bridgeSignerPk !== ONE_CLICK.managerPublicKey) {
    problems.push(
      `bridge_signer_pk is ${config.bridgeSignerPk}, expected ${ONE_CLICK.managerPublicKey}: 1Click rotated its key or the ` +
        "policy is misconfigured; the owner must call set_bridge_signer",
    );
  }
  if (config.baseAddress === null) {
    problems.push("base_address is null: the policy is not activated yet; run activate on it (anyone can, 50 TGas)");
  } else {
    if (!same(config.baseAddress, expected.chainsigAddress)) {
      problems.push(`base_address is ${config.baseAddress} but chainsig.js derives ${expected.chainsigAddress}`);
    }
    if (!same(config.baseAddress, expected.mpcViewAddress)) {
      problems.push(`base_address is ${config.baseAddress} but v1.signer.derived_public_key gives ${expected.mpcViewAddress}`);
    }
  }
  if (expected.agentAccountId !== undefined && config.agent !== expected.agentAccountId) {
    problems.push(`agent is ${config.agent} but AGENT_ACCOUNT_ID is ${expected.agentAccountId} (owner can fix with set_agent)`);
  }
  const rehearsalOk = expected.allowKeyedRehearsal === true && expected.accessKeyCount === 1;
  if (expected.accessKeyCount > 0 && !rehearsalOk) {
    problems.push(
      `the policy account has ${expected.accessKeyCount} access key(s); a full-access key bypasses every limit. ` +
        "Use a policy created by the factory or deploy-policy v2" +
        (expected.allowKeyedRehearsal ? " (--allow-keyed-rehearsal accepts exactly one key)" : ""),
    );
  }
  if (problems.length || config.baseAddress === null) {
    throw new Error(`Policy contract does not match this agent:\n  - ${problems.join("\n  - ")}\nRefusing to run.`);
  }
  return { ...config, baseAddress: config.baseAddress, chain };
}

export interface TxParams {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
  /** Notes for the log (e.g. the fee was clamped to the contract's cap). */
  notes: string[];
}

/** Gas headroom over `eth_estimateGas`. */
const GAS_BUFFER_PCT = 120n;

/**
 * Fees and gas limit inside the contract's caps (`max_fee_per_gas`, `max_gas_limit`), so the policy
 * will not reject them. A fee estimate above the cap is clamped (the tx may wait for cheaper
 * blocks); a gas estimate above the cap is an error, since the tx would run out of gas.
 */
export function pickTxParams(
  estimate: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  gasEstimate: bigint,
  limits: Pick<Limits, "maxFeePerGas" | "maxGasLimit">,
): TxParams {
  const notes: string[] = [];
  let maxFeePerGas = estimate.maxFeePerGas;
  if (maxFeePerGas > limits.maxFeePerGas) {
    notes.push(`fee estimate ${maxFeePerGas} wei above the contract cap; using the cap ${limits.maxFeePerGas} wei`);
    maxFeePerGas = limits.maxFeePerGas;
  }
  const maxPriorityFeePerGas = estimate.maxPriorityFeePerGas < maxFeePerGas ? estimate.maxPriorityFeePerGas : maxFeePerGas;
  if (gasEstimate > limits.maxGasLimit) {
    throw new Error(
      `The tx needs ~${gasEstimate} gas but the contract caps gas_limit at ${limits.maxGasLimit}. ` +
        "Raise max_gas_limit with set_limits (owner) and re-run.",
    );
  }
  const buffered = (gasEstimate * GAS_BUFFER_PCT) / 100n;
  const gasLimit = buffered > limits.maxGasLimit ? limits.maxGasLimit : buffered;
  return { maxFeePerGas, maxPriorityFeePerGas, gasLimit, notes };
}

/**
 * The one call the policy builds for each kind: `repay(usdc, amount, 2, borrower)` on the Pool, or
 * `approve(pool, daily_cap)` on Base USDC.
 */
export function expectedCall(
  kind: TxKind,
  config: Pick<ActivePolicyConfig, "aavePool" | "usdcBase" | "onBehalfOf">,
  amount: bigint,
): { to: Address; data: Hex } {
  return kind === "repay"
    ? { to: config.aavePool, data: encodeRepay(config.usdcBase, amount, config.onBehalfOf) }
    : { to: config.usdcBase, data: encodeApprove(config.aavePool, amount) };
}

export interface ExpectedTx {
  kind: TxKind;
  /** The policy's loan chain id: the signed tx must be for exactly this chain. */
  chainId: number;
  /** The derived address: the tx must recover to it. */
  from: Address;
  to: Address;
  data: Hex;
  amount: bigint;
  args: TxArgs;
}

/**
 * Re-checks a tx the policy signed before it is broadcast: kind, amount, hash, type, chain, nonce,
 * destination, value 0, exact calldata, our fees and gas, and that it recovers to the derived address.
 */
export async function verifySignedTx(signed: RescueSigned, e: ExpectedTx): Promise<void> {
  const problems: string[] = [];
  if (signed.kind !== e.kind) problems.push(`kind is ${signed.kind}, expected ${e.kind}`);
  if (signed.amount !== e.amount) problems.push(`amount is ${signed.amount}, expected ${e.amount}`);
  if (keccak256(signed.signedTx) !== signed.txHash) problems.push("tx_hash is not keccak256(signed_tx)");
  const tx = parseTransaction(signed.signedTx);
  if (tx.type !== "eip1559") problems.push(`type is ${tx.type}, expected eip1559`);
  if (tx.chainId !== e.chainId) problems.push(`chainId is ${tx.chainId}, expected ${e.chainId}`);
  if (tx.nonce !== e.args.evmNonce) problems.push(`nonce is ${tx.nonce}, expected ${e.args.evmNonce}`);
  if (!tx.to || getAddress(tx.to) !== getAddress(e.to)) problems.push(`to is ${tx.to}, expected ${e.to}`);
  if ((tx.value ?? 0n) !== 0n) problems.push(`value is ${tx.value}, expected 0`);
  if ((tx.data ?? "0x").toLowerCase() !== e.data.toLowerCase()) problems.push(`calldata is not the expected ${e.kind} call`);
  if (tx.maxFeePerGas !== e.args.maxFeePerGas) problems.push(`maxFeePerGas is ${tx.maxFeePerGas}, expected ${e.args.maxFeePerGas}`);
  if (tx.maxPriorityFeePerGas !== e.args.maxPriorityFeePerGas) {
    problems.push(`maxPriorityFeePerGas is ${tx.maxPriorityFeePerGas}, expected ${e.args.maxPriorityFeePerGas}`);
  }
  if (tx.gas !== e.args.gasLimit) problems.push(`gas is ${tx.gas}, expected ${e.args.gasLimit}`);
  if (problems.length === 0) {
    const signer = await recoverTransactionAddress({ serializedTransaction: signed.signedTx as `0x02${string}` });
    if (getAddress(signer) !== getAddress(e.from)) problems.push(`recovers to ${signer}, expected ${e.from}`);
  }
  if (problems.length) {
    throw new Error(`Signed tx from the policy contract failed verification (${problems.join("; ")}). Not broadcasting.`);
  }
}
