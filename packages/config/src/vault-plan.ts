/**
 * The pure numbers and arguments of a policy deploy, shared by the operator scripts
 * (scripts/src/lib/deploy-plan.ts), the bot's vault creator (apps/agent) and the web's create review.
 * Browser-safe: no Node imports, no env reads. Import it from client code as `@backstop/config/vault-plan`.
 */
import type { LimitsJson } from "@backstop/core";
import { FEE, NEAR, ONE_CLICK, type LoanChain } from "./registry.js";

const YOCTO_PER_NEAR = 10n ** 24n;
const MILLI = YOCTO_PER_NEAR / 1000n;

/** NEAR storage staking price, yoctoNEAR per byte (protocol config `storage_amount_per_byte`). */
export const STORAGE_BYTE_YOCTO = 10n ** 19n;
/** Contract state after `new` + `activate` is ~1 KB; 0.05 NEAR covers it with room to spare. */
export const STATE_MARGIN_YOCTO = 50n * MILLI;
/**
 * Spare balance at creation (C.13): MPC deposits, used-quote entries, token storage for 1Click
 * deposit addresses (~0.002 NEAR per bridge, so ~125 bridges). Withdrawable with withdraw_near;
 * anyone can top it up.
 */
export const SPARE_YOCTO = 100n * MILLI;
/** Gas the deploying key pays (prepaid 80 + 30 TGas at <= 0.0001 NEAR/TGas, plus deploy fees). */
export const DEPLOYER_GAS_RESERVE_YOCTO = 20n * MILLI;
/** Gas for the policy's `new`. */
export const NEW_TGAS = 30;

export interface DeployBudget {
  /** Storage stake of the code: returned when the vault is closed (the account is deleted). */
  codeStake: bigint;
  stateMargin: bigint;
  spare: bigint;
  /** What the policy account holds after creation: codeStake + stateMargin + spare. */
  transfer: bigint;
  /** USDC storage_deposit for the policy. */
  storageDeposit: bigint;
  gasReserve: bigint;
  /** Everything the creation costs: transfer + storageDeposit + gasReserve. */
  deployerNeeds: bigint;
}

export function deployBudget(codeBytes: number, perByteYocto: bigint, storageDepositYocto: bigint): DeployBudget {
  if (!Number.isSafeInteger(codeBytes) || codeBytes <= 0) throw new Error(`The policy wasm size must be a positive number of bytes, got ${codeBytes}.`);
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
 * Factory-less creation: the yoctoNEAR the user's wallet attaches to `near.create_account` for a vault
 * whose policy wasm has `codeBytes` bytes. The bot refuses to deploy into an account holding less.
 */
export const vaultCreateDeposit = (codeBytes: number): bigint =>
  deployBudget(codeBytes, STORAGE_BYTE_YOCTO, BigInt(NEAR.usdcStorageDeposit)).deployerNeeds;

export interface PolicyInitInput {
  chain: LoanChain;
  owner: string;
  agent: string;
  /** EIP-55 checksummed 0x address of the Aave borrower on `chain`. */
  borrower: string;
  limits: LimitsJson;
  feeAccount: string;
  feeBps: number;
}

/** Args of the policy's `new`, every chain constant from the registry. Callers validate ids and checksum the borrower. */
export function policyInitArgs(input: PolicyInitInput): Record<string, unknown> {
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > FEE.maxBps) {
    throw new Error(`FEE_BPS must be a whole number from 0 to ${FEE.maxBps} (the contract's cap), got ${input.feeBps}.`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.borrower)) throw new Error(`The borrower must be a 0x ${input.chain.name} address, got "${input.borrower}".`);
  return {
    owner: input.owner,
    agent: input.agent,
    on_behalf_of: input.borrower,
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

/** `near.create_account` needs at least this much gas or the callback that creates the account can run out. */
export const CREATE_ACCOUNT_TGAS = 50;
/** The registrar that creates top-level `.near` accounts. */
export const NEAR_REGISTRAR = "near";

/** Most vaults one owner may have open or in creation (the same cap the factory had). */
export const MAX_VAULTS_PER_OWNER = 8;
