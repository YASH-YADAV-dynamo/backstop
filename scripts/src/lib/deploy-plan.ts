/**
 * The keyless policy deploy as pure data: account id, `new`
 * args, NEAR budget and the one transaction's actions. No network, no env, so it is unit-tested.
 */
import { PublicKey, actions, teraToGas, type Action } from "near-api-js";
import { getAddress, isAddress } from "viem";
import { FEE, NEAR, ONE_CLICK, POLICY, isNearAccountId, type LoanChain } from "@backstop/config";
import type { LimitsJson } from "./limits.js";

const YOCTO_PER_NEAR = 10n ** 24n;
const MILLI = YOCTO_PER_NEAR / 1000n;

/** Contract state after `new` + `activate` is ~1 KB; 0.05 NEAR covers it with room to spare. */
export const STATE_MARGIN_YOCTO = 50n * MILLI;
/**
 * Spare balance at creation (C.13): MPC deposits, used-quote entries, token storage for 1Click
 * deposit addresses (~0.002 NEAR per bridge, so ~125 bridges). Withdrawable with withdraw_near;
 * anyone can top it up.
 */
export const SPARE_YOCTO = 100n * MILLI;
/** Deployer-side gas for both transactions (prepaid 80 + 30 TGas at <= 0.0001 NEAR/TGas, plus deploy fees). */
export const DEPLOYER_GAS_RESERVE_YOCTO = 20n * MILLI;

export const NEW_TGAS = 30;

export interface DeployInput {
  /** The chain the borrower's Aave loan lives on (D29): one policy per (user, chain). */
  chain: LoanChain;
  /** Sub-account label: the policy becomes `<name>.<deployer>` on Base, `<name>-arb.<deployer>` on Arbitrum. */
  name: string;
  deployer: string;
  owner: string;
  agent: string;
  /** The user's wallet on `chain` that holds the Aave loan. */
  borrower: string;
  limits: LimitsJson;
  /** Service fee recipient (NEAR account) and rate in bps of each bridged amount; 0 = no fee. */
  feeAccount: string;
  feeBps: number;
}

/**
 * Suffix that keeps one user's policies on different chains from colliding. Base has none, so every
 * policy created before D29 keeps its name. A `Record` over the chain keys: adding a chain to the
 * registry fails to compile until it gets a suffix here.
 */
const ACCOUNT_SUFFIX: Record<LoanChain["key"], string> = { base: "", arbitrum: "-arb" };

export function policyAccountId(name: string, deployer: string, chain: LoanChain): string {
  if (!/^[a-z\d]+([-_][a-z\d]+)*$/.test(name)) {
    throw new Error(`--name must be one account label (lowercase letters, digits, - or _; no dots), got "${name}".`);
  }
  const id = `${name}${ACCOUNT_SUFFIX[chain.key]}.${deployer}`;
  if (!isNearAccountId(id)) throw new Error(`${id} is not a valid NEAR account id (max 64 chars). Use a shorter --name.`);
  return id;
}

/** Args of the policy's `new`, every chain constant from the registry. */
export function initArgs(input: DeployInput): Record<string, unknown> {
  for (const [flag, id] of [["--owner", input.owner], ["--agent / AGENT_ACCOUNT_ID", input.agent]] as const) {
    if (!isNearAccountId(id)) throw new Error(`${flag} must be a NEAR account id like alice.near, got "${id}".`);
  }
  if (!isNearAccountId(input.feeAccount)) throw new Error(`FEE_ACCOUNT_ID must be a NEAR account id, got "${input.feeAccount}".`);
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > FEE.maxBps) {
    throw new Error(`FEE_BPS must be a whole number from 0 to ${FEE.maxBps} (the contract's cap), got ${input.feeBps}.`);
  }
  if (!isAddress(input.borrower)) throw new Error(`--borrower must be the 0x ${input.chain.name} address that holds the Aave loan, got "${input.borrower}".`);
  return {
    owner: input.owner,
    agent: input.agent,
    on_behalf_of: getAddress(input.borrower),
    chain_id: input.chain.chainId,
    aave_pool: input.chain.aave.pool,
    usdc_base: input.chain.aave.usdc,
    usdc_near: NEAR.usdcToken,
    bridge_dest_asset: input.chain.usdcAssetId,
    bridge_signer_pk: ONE_CLICK.managerPublicKey,
    mpc_contract: NEAR.mpcContract,
    derivation_path: NEAR.derivationPath,
    limits: input.limits,
    fee_account: input.feeAccount,
    fee_bps: input.feeBps,
  };
}

export interface DeployBudget {
  /** Locked for good: the account has no key, so the code can never be removed. */
  codeStake: bigint;
  stateMargin: bigint;
  spare: bigint;
  /** The `Transfer` action: codeStake + stateMargin + spare. */
  transfer: bigint;
  /** USDC storage_deposit for the policy (second transaction). */
  storageDeposit: bigint;
  gasReserve: bigint;
  /** What the deployer account must hold on top of its own storage. */
  deployerNeeds: bigint;
}

export function deployBudget(codeBytes: number, perByteYocto: bigint, storageDepositYocto: bigint): DeployBudget {
  const codeStake = BigInt(codeBytes) * perByteYocto;
  const transfer = codeStake + STATE_MARGIN_YOCTO + SPARE_YOCTO;
  return {
    codeStake,
    stateMargin: STATE_MARGIN_YOCTO,
    spare: SPARE_YOCTO,
    transfer,
    storageDeposit: storageDepositYocto,
    gasReserve: DEPLOYER_GAS_RESERVE_YOCTO,
    deployerNeeds: transfer + storageDepositYocto + DEPLOYER_GAS_RESERVE_YOCTO,
  };
}

/**
 * The single creating transaction, receiver `<name>.<deployer>`: CreateAccount, Transfer,
 * DeployContract, FunctionCall new, FunctionCall activate. No AddKey: nobody, the deployer
 * included, can ever sign for the policy account.
 *
 * `rehearsalKey` (audit F2, design D24) adds ONE temporary full-access key so a first mainnet
 * policy can be fixed if a gas constant or an external API behaves differently than tested.
 * The agent and the web refuse a keyed policy; `finalizeActions` deletes the key.
 */
export function deployActions(
  code: Uint8Array,
  args: Record<string, unknown>,
  transfer: bigint,
  rehearsalKey?: string,
): Action[] {
  return [
    actions.createAccount(),
    actions.transfer(transfer),
    ...(rehearsalKey === undefined ? [] : [actions.addFullAccessKey(PublicKey.fromString(rehearsalKey))]),
    actions.deployContract(code),
    actions.functionCall("new", args, teraToGas(NEW_TGAS), 0n),
    actions.functionCall("activate", {}, teraToGas(POLICY.gas.activate), 0n),
  ];
}

/** Rehearsal fix-up: replace the code of a still-keyed policy (state is kept). */
export function redeployActions(code: Uint8Array): Action[] {
  return [actions.deployContract(code)];
}

/** Ends a rehearsal: the policy deletes its only key and becomes keyless for good. */
export function finalizeActions(rehearsalKey: string): Action[] {
  return [actions.deleteKey(PublicKey.fromString(rehearsalKey))];
}

/** Aborts a failed keyed rehearsal: the policy deletes itself and returns every yoctoNEAR to the deployer. */
export function abortActions(beneficiary: string): Action[] {
  return [actions.deleteAccount(beneficiary)];
}

export const formatNear = (yocto: bigint, decimals = 5): string => {
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = (yocto % YOCTO_PER_NEAR).toString().padStart(24, "0").slice(0, decimals);
  return `${whole}.${frac} NEAR`;
};
