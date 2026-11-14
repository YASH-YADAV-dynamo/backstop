/**
 * The keyless factory deploy (design D32, section K) as pure data: factory account id, the
 * `new({ config })` args, the NEAR budget and the one transaction's actions. No network, no env.
 * Every check mirrors `contracts/factory/src/lib.rs` `validate_config`, so a bad config fails here,
 * before anything is sent.
 */
import { PublicKey, actions, baseDecode, teraToGas, type Action } from "near-api-js";
import { isAddress } from "viem";
import { FEE, NEAR, ONE_CLICK, isNearAccountId, type LoanChain } from "@backstop/config";
import { DEPLOYER_GAS_RESERVE_YOCTO, SPARE_YOCTO, STATE_MARGIN_YOCTO } from "./deploy-plan.js";

const MILLI = 10n ** 21n;

/** Gas for the factory's `new` (it hashes the embedded policy wasm). */
export const FACTORY_NEW_TGAS = 50;
/** Longest factory id: `<key>-<u64 index>.<factory>` must fit NEAR's 64-char account ids. */
const MAX_ACCOUNT_ID_LEN = 64;
const MAX_INDEX_DIGITS = 20;

/** Mirrors of the factory's constants (contracts/factory/src/lib.rs); `min_deposit()` is computed from them. */
export const FACTORY_CONSTANTS = {
  policyStateMargin: 50n * MILLI,
  policySpare: 100n * MILLI,
  ftStorageDeposit: BigInt(NEAR.usdcStorageDeposit),
  indexFee: 5n * MILLI,
  maxFeeBps: 50,
} as const;

export interface ChainConfigJson {
  key: string;
  chain_id: number;
  aave_pool: string;
  usdc: string;
  bridge_dest_asset: string;
}

/** The factory's `FactoryConfig` as JSON (the `new` argument and the `get_config` view). */
export interface FactoryConfigJson {
  chains: ChainConfigJson[];
  usdc_near: string;
  bridge_signer_pk: string;
  mpc_contract: string;
  derivation_path: string;
  default_agent: string;
  fee_account: string;
  fee_bps: number;
}

export interface FactoryConfigInput {
  factoryId: string;
  chains: readonly LoanChain[];
  agent: string;
  feeAccount: string;
  feeBps: number;
}

/** `<name>.<deployer>`, checked so every vault name `<key>-<u64>.<factory>` stays a valid account id. */
export function factoryAccountId(name: string, deployer: string, chains: readonly LoanChain[]): string {
  if (!/^[a-z\d]+([-_][a-z\d]+)*$/.test(name)) {
    throw new Error(`--name must be one account label (lowercase letters, digits, - or _; no dots), got "${name}".`);
  }
  const id = `${name}.${deployer}`;
  if (!isNearAccountId(id)) throw new Error(`${id} is not a valid NEAR account id. Use a shorter --name.`);
  const longestKey = Math.max(...chains.map((c) => c.key.length));
  const max = MAX_ACCOUNT_ID_LEN - longestKey - MAX_INDEX_DIGITS - 2;
  if (id.length > max) {
    throw new Error(`${id} is ${id.length} chars; a factory id may have at most ${max} so vault names fit 64. Use a shorter --name.`);
  }
  return id;
}

const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s) && isAddress(s, { strict: false }) && !/^0x0{40}$/.test(s);

function isEd25519(pk: string): boolean {
  if (!pk.startsWith("ed25519:")) return false;
  try {
    return baseDecode(pk.slice("ed25519:".length)).length === 32;
  } catch {
    return false;
  }
}

/** Builds the factory config from the chain registry; throws with the contract's error code on any rule it would break. */
export function factoryConfig(input: FactoryConfigInput): FactoryConfigJson {
  if (input.chains.length === 0) throw new Error("ERR_NO_CHAINS: the factory needs at least one loan chain.");
  const chains = input.chains.map((c, i): ChainConfigJson => {
    if (!/^[a-z]{1,12}$/.test(c.key)) throw new Error(`ERR_CHAIN_KEY_FORMAT: chains[${i}].key "${c.key}" must be 1-12 lowercase letters.`);
    if (!Number.isSafeInteger(c.chainId) || c.chainId <= 0) throw new Error(`ERR_CHAIN_ID_ZERO: chains[${i}].chain_id`);
    for (const [field, value] of [["aave_pool", c.aave.pool], ["usdc", c.aave.usdc]] as const) {
      if (!isEvmAddress(value)) throw new Error(`chains[${i}].${field} "${value}" is not a non-zero 0x address.`);
    }
    if (!c.usdcAssetId) throw new Error(`ERR_CONFIG_FIELD_EMPTY: chains[${i}].bridge_dest_asset`);
    return { key: c.key, chain_id: c.chainId, aave_pool: c.aave.pool, usdc: c.aave.usdc, bridge_dest_asset: c.usdcAssetId };
  });
  chains.forEach((c, i) => {
    if (chains.slice(0, i).some((p) => p.key === c.key || p.chain_id === c.chain_id)) {
      throw new Error(`ERR_DUPLICATE_CHAIN: chains[${i}] (${c.key}, ${c.chain_id}) repeats an earlier chain.`);
    }
  });
  for (const [what, id] of [["AGENT_ACCOUNT_ID / --agent", input.agent], ["FEE_ACCOUNT_ID", input.feeAccount]] as const) {
    if (!isNearAccountId(id)) throw new Error(`${what} must be a NEAR account id like name.near, got "${id}".`);
  }
  const maxBps = Math.min(FEE.maxBps, FACTORY_CONSTANTS.maxFeeBps);
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > maxBps) {
    throw new Error(`ERR_FEE_ABOVE_CAP_BPS: FEE_BPS must be a whole number from 0 to ${maxBps}, got ${input.feeBps}.`);
  }
  if (input.feeAccount === input.factoryId) {
    throw new Error("ERR_FEE_ACCOUNT_IS_FACTORY: FEE_ACCOUNT_ID must be an account you control, not the factory.");
  }
  if (!isEd25519(ONE_CLICK.managerPublicKey)) throw new Error("ERR_BRIDGE_SIGNER_FORMAT: ONE_CLICK.managerPublicKey in the registry");
  if (!NEAR.derivationPath) throw new Error("ERR_CONFIG_FIELD_EMPTY: derivation_path");
  return {
    chains,
    usdc_near: NEAR.usdcToken,
    bridge_signer_pk: ONE_CLICK.managerPublicKey,
    mpc_contract: NEAR.mpcContract,
    derivation_path: NEAR.derivationPath,
    default_agent: input.agent,
    fee_account: input.feeAccount,
    fee_bps: input.feeBps,
  };
}

/** What the factory's `min_deposit()` view will return for this policy wasm and storage price. */
export function minDeposit(policyWasmBytes: number, perByteYocto: bigint): bigint {
  const k = FACTORY_CONSTANTS;
  return BigInt(policyWasmBytes) * perByteYocto + k.policyStateMargin + k.policySpare + k.ftStorageDeposit + k.indexFee;
}

export interface FactoryBudget {
  /** Locked for good: the factory has no key, so its code (which embeds the policy) is never removed. */
  codeStake: bigint;
  stateMargin: bigint;
  spare: bigint;
  /** The `Transfer` action: codeStake + stateMargin + spare. */
  transfer: bigint;
  gasReserve: bigint;
  deployerNeeds: bigint;
  /** Per vault, paid by the user: the factory's `min_deposit()`. */
  minDeposit: bigint;
}

export function factoryBudget(factoryWasmBytes: number, policyWasmBytes: number, perByteYocto: bigint): FactoryBudget {
  const codeStake = BigInt(factoryWasmBytes) * perByteYocto;
  const transfer = codeStake + STATE_MARGIN_YOCTO + SPARE_YOCTO;
  return {
    codeStake,
    stateMargin: STATE_MARGIN_YOCTO,
    spare: SPARE_YOCTO,
    transfer,
    gasReserve: DEPLOYER_GAS_RESERVE_YOCTO,
    deployerNeeds: transfer + DEPLOYER_GAS_RESERVE_YOCTO,
    minDeposit: minDeposit(policyWasmBytes, perByteYocto),
  };
}

/**
 * The single creating transaction, receiver `<name>.<deployer>`: CreateAccount, Transfer,
 * DeployContract, FunctionCall new. No AddKey unless `rehearsalKey` (D24): one temporary
 * full-access key, removed with `finalizeActions`; the web refuses a keyed factory.
 */
export function factoryDeployActions(code: Uint8Array, config: FactoryConfigJson, transfer: bigint, rehearsalKey?: string): Action[] {
  return [
    actions.createAccount(),
    actions.transfer(transfer),
    ...(rehearsalKey === undefined ? [] : [actions.addFullAccessKey(PublicKey.fromString(rehearsalKey))]),
    actions.deployContract(code),
    actions.functionCall("new", { config }, teraToGas(FACTORY_NEW_TGAS), 0n),
  ];
}

/** True if `outer` contains `inner` byte for byte (the factory wasm embeds the policy wasm). */
export function embeds(outer: Uint8Array, inner: Uint8Array): boolean {
  return Buffer.from(outer.buffer, outer.byteOffset, outer.byteLength).indexOf(Buffer.from(inner.buffer, inner.byteOffset, inner.byteLength)) >= 0;
}

/** The lines to paste into .env (and the web host) after the factory is live. */
export function factoryEnvLines(factoryId: string, policySha256Hex: string): string[] {
  return [`FACTORY_CONTRACT_ID=${factoryId}`, `NEXT_PUBLIC_FACTORY_ID=${factoryId}`, `NEXT_PUBLIC_POLICY_CODE_HASH=${policySha256Hex}`];
}
