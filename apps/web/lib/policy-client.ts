/**
 * Typed reads of the policy / factory / USDC token / v1.signer contracts (zod on every response),
 * the C.14 verification checks, and builders for every NEAR wallet action.
 * Nothing here signs or sends anything.
 */
import { FEE, NEAR, ONE_CLICK, POLICY, SUPPORTED_CHAIN_NAMES } from "@backstop/config/registry";
import { getAddress, keccak256, type Address } from "viem";
import { z } from "zod";
import { accessKeyCount, viewAccount, viewFunction, type AccountInfo } from "@/lib/near-rpc";
import { resolveChain } from "@/lib/chain";
import { PUBLIC_ENV } from "@/lib/public-env";
import { base58Decode, hexToNearCodeHash, type LimitsJson } from "@/lib/validate";

/** U128 / U64 cross JSON as decimal strings; plain numbers are accepted too. */
const uint = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform((v) => BigInt(v));
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const configSchema = z.object({
  version: z.string(),
  owner: z.string(),
  agent: z.string(),
  base_address: evmAddress.nullable(),
  on_behalf_of: evmAddress,
  chain_id: z.number(),
  aave_pool: evmAddress,
  usdc_base: evmAddress,
  usdc_near: z.string(),
  bridge_dest_asset: z.string(),
  bridge_signer_pk: z.string(),
  mpc_contract: z.string(),
  derivation_path: z.string(),
  fee_account: z.string(),
  fee_bps: z.number(),
});

export const limitsSchema = z.object({
  trigger_hf_bps: z.number(),
  target_hf_bps: z.number(),
  max_per_rescue: uint,
  daily_cap: uint,
  cooldown_secs: uint,
  max_fee_per_gas: uint,
  max_gas_limit: uint,
  paused: z.boolean(),
});

export const statusSchema = z.object({
  spent_today: uint,
  day_start: uint,
  last_rescue_at: uint,
  rescue_count: z.number(),
  remaining_today: uint,
  cooldown_ends_at: uint,
  bridge_spent_today: uint,
  bridge_remaining_today: uint,
  last_bridge_at: uint,
  bridge_cooldown_ends_at: uint,
  bridge_count: z.number(),
  last_approve_at: uint,
  last_bridge: z
    .object({ bridge_id: z.number(), amount_in: uint, min_amount_out: uint, deposit_address: z.string(), funded_at: uint })
    .nullable(),
});

const storageBalanceSchema = z.object({ total: z.string(), available: z.string() }).nullable();
const derivedKeySchema = z.string().regex(/^secp256k1:[1-9A-HJ-NP-Za-km-z]+$/);

export type PolicyConfig = z.infer<typeof configSchema>;
export type PolicyLimits = z.infer<typeof limitsSchema>;
export type PolicyStatus = z.infer<typeof statusSchema>;

export type CheckState = "pass" | "fail" | "unknown";
export type Check = { id: string; label: string; state: CheckState; detail: string };

export type PolicySnapshot = {
  policyId: string;
  config: PolicyConfig;
  limits: PolicyLimits;
  status: PolicyStatus;
  usdcBalance: bigint;
  account: AccountInfo;
  keyCount: number;
  /** Address derived from (policy, path) by v1.signer, or null when the view could not be read. */
  derivedAddress: Address | null;
  fetchedAt: number;
};

/** address = last 20 bytes of keccak256(x || y) of the uncompressed secp256k1 public key. */
export function addressFromDerivedKey(key: string): Address {
  const raw = base58Decode(key.replace(/^secp256k1:/, ""));
  if (raw.length !== 64) throw new Error(`v1.signer returned a ${raw.length}-byte public key; expected 64`);
  return getAddress(`0x${keccak256(raw).slice(-40)}`);
}

export async function readDerivedAddress(policyId: string): Promise<Address> {
  const key = await viewFunction(NEAR.mpcContract, "derived_public_key", { path: NEAR.derivationPath, predecessor: policyId, domain_id: 0 }, derivedKeySchema);
  return addressFromDerivedKey(key);
}

export async function readUsdcBalance(accountId: string): Promise<bigint> {
  return viewFunction(NEAR.usdcToken, "ft_balance_of", { account_id: accountId }, z.string().regex(/^\d+$/)).then(BigInt);
}

/** `null` = the account is not registered on the USDC token. */
export async function readUsdcStorage(accountId: string) {
  return viewFunction(NEAR.usdcToken, "storage_balance_of", { account_id: accountId }, storageBalanceSchema);
}

export async function readPolicy(policyId: string): Promise<PolicySnapshot> {
  const account = await viewAccount(policyId);
  if (!account) throw new Error(`${policyId} does not exist on NEAR mainnet. Check the account id.`);
  const [config, limits, status, usdcBalance, keyCount] = await Promise.all([
    viewFunction(policyId, "get_config", {}, configSchema),
    viewFunction(policyId, "get_limits", {}, limitsSchema),
    viewFunction(policyId, "get_status", {}, statusSchema),
    readUsdcBalance(policyId),
    accessKeyCount(policyId),
  ]);
  const derivedAddress = await readDerivedAddress(policyId).catch(() => null);
  return { policyId, config, limits, status, usdcBalance, account, keyCount, derivedAddress, fetchedAt: Date.now() };
}

export type ExpectedCodeHash = { hex: string; source: "factory" | "configured" };

/** The published policy code hash: the factory's answer if a factory is configured, else the env value. */
export async function readExpectedCodeHash(): Promise<ExpectedCodeHash | null> {
  if (PUBLIC_ENV.factoryId) {
    const hex = await viewFunction(PUBLIC_ENV.factoryId, "policy_code_hash", {}, z.string().regex(/^[0-9a-fA-F]{64}$/));
    return { hex: hex.toLowerCase(), source: "factory" };
  }
  return PUBLIC_ENV.policyCodeHash ? { hex: PUBLIC_ENV.policyCodeHash, source: "configured" } : null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** C.14 checks 1-3 plus the constants the agent also refuses to start without (D.3). */
export function verifyPolicy(snap: PolicySnapshot, expected: ExpectedCodeHash | null): Check[] {
  const c = snap.config;
  const checks: Check[] = [];
  checks.push(
    snap.keyCount === 0
      ? { id: "keys", label: "No access keys", state: "pass", detail: "Nobody can sign as this account or bypass its limits." }
      : { id: "keys", label: "No access keys", state: "fail", detail: `The account has ${snap.keyCount} access key(s). A full-access key bypasses every limit.` },
  );
  if (!expected) {
    checks.push({
      id: "code",
      label: "Contract code",
      state: "unknown",
      detail: "No published code hash is configured, so the deployed code cannot be compared. Verify the code hash on NearBlocks yourself.",
    });
  } else {
    const want = hexToNearCodeHash(expected.hex);
    checks.push(
      snap.account.codeHash === want
        ? { id: "code", label: "Contract code", state: "pass", detail: `Code hash matches the published hash (${expected.source}).` }
        : { id: "code", label: "Contract code", state: "fail", detail: `Code hash ${snap.account.codeHash} is not the published ${want}.` },
    );
  }
  checks.push(
    c.version === POLICY.version
      ? { id: "version", label: "Policy version", state: "pass", detail: `Version ${c.version}.` }
      : { id: "version", label: "Policy version", state: "fail", detail: `Version ${c.version}; this app supports ${POLICY.version}.` },
  );
  const chain = resolveChain(c.chain_id);
  const constants: Array<[string, boolean]> = [
    [`chain id is a supported chain (${SUPPORTED_CHAIN_NAMES}), not ${c.chain_id}`, chain !== null],
    [`Aave pool is the official ${chain?.name ?? "loan chain"} pool`, chain !== null && same(c.aave_pool, chain.aave.pool)],
    [`repay asset is ${chain?.name ?? "loan chain"} USDC`, chain !== null && same(c.usdc_base, chain.aave.usdc)],
    ["NEAR token is USDC", c.usdc_near === NEAR.usdcToken],
    [`bridge destination is ${chain?.name ?? "loan chain"} USDC`, chain !== null && c.bridge_dest_asset === chain.usdcAssetId],
    ["bridge quotes must be signed by the 1Click key", c.bridge_signer_pk === ONE_CLICK.managerPublicKey],
    ["signing contract is v1.signer", c.mpc_contract === NEAR.mpcContract],
    ["derivation path is the Backstop path", c.derivation_path === NEAR.derivationPath],
    [`service fee is at most ${(FEE.maxBps / 100).toFixed(2)}%`, c.fee_bps <= FEE.maxBps],
  ];
  const bad = constants.filter(([, ok]) => !ok).map(([what]) => what);
  checks.push(
    bad.length === 0
      ? { id: "constants", label: "Chain constants", state: "pass", detail: "Chain, Aave pool, USDC assets, 1Click key and signer all match." }
      : { id: "constants", label: "Chain constants", state: "fail", detail: `Mismatch: ${bad.join("; ")} differ from what Backstop expects.` },
  );
  const addressLabel = `${chain?.name ?? "Loan chain"} address`;
  if (c.base_address === null) {
    checks.push({ id: "derived", label: addressLabel, state: "unknown", detail: `Not activated yet: the policy has not derived its ${chain?.name ?? "loan chain"} address. Activate it (anyone can).` });
  } else if (!snap.derivedAddress) {
    checks.push({ id: "derived", label: addressLabel, state: "unknown", detail: `Could not read v1.signer to cross-check the ${chain?.name ?? "loan chain"} address. Retry.` });
  } else {
    checks.push(
      same(c.base_address, snap.derivedAddress)
        ? { id: "derived", label: addressLabel, state: "pass", detail: "Equals the address v1.signer derives for this policy." }
        : { id: "derived", label: addressLabel, state: "fail", detail: `Policy says ${c.base_address} but v1.signer derives ${snap.derivedAddress}.` },
    );
  }
  return checks;
}

/** Row 26: any failed check blocks funding. `unknown` checks need the user's explicit acknowledgement. */
export const failedChecks = (checks: Check[]) => checks.filter((k) => k.state === "fail");
export const unknownChecks = (checks: Check[]) => checks.filter((k) => k.state === "unknown" && k.id !== "derived");

// ---- Wallet actions (G.3) -------------------------------------------------------------------

export type NearCall = { methodName: string; args: Record<string, unknown>; gasTgas: number; depositYocto: string };
export type NearTx = { receiverId: string; calls: NearCall[] };

const tgas = (n: number) => (BigInt(n) * 10n ** 12n).toString();
export const gasUnits = (call: NearCall) => tgas(call.gasTgas);

export const ONE_YOCTO = "1";

export const storageDepositCall = (accountId: string): NearCall => ({
  methodName: "storage_deposit",
  args: { account_id: accountId, registration_only: true },
  gasTgas: 30,
  depositYocto: NEAR.usdcStorageDeposit,
});

/** Deposit USDC into the policy; adds the policy's token registration when it is missing (E.3 step 4). */
export function depositUsdcTx(policyId: string, amount: bigint, registerPolicy: boolean): NearTx {
  const calls: NearCall[] = [];
  if (registerPolicy) calls.push(storageDepositCall(policyId));
  calls.push({ methodName: "ft_transfer_call", args: { receiver_id: policyId, amount: amount.toString(), msg: "" }, gasTgas: 60, depositYocto: ONE_YOCTO });
  return { receiverId: NEAR.usdcToken, calls };
}

export const registerOnUsdcTx = (accountId: string): NearTx => ({ receiverId: NEAR.usdcToken, calls: [storageDepositCall(accountId)] });

export const withdrawTx = (policyId: string, amount: bigint): NearTx => ({
  receiverId: policyId,
  calls: [{ methodName: "withdraw", args: { amount: amount.toString() }, gasTgas: POLICY.gas.withdraw, depositYocto: ONE_YOCTO }],
});

/** `pause` takes NO deposit on purpose (C.4): pausing must be as easy as possible. */
export const pauseTx = (policyId: string): NearTx => ({
  receiverId: policyId,
  calls: [{ methodName: "pause", args: {}, gasTgas: POLICY.gas.owner, depositYocto: "0" }],
});

export const unpauseTx = (policyId: string): NearTx => ({
  receiverId: policyId,
  calls: [{ methodName: "unpause", args: {}, gasTgas: POLICY.gas.owner, depositYocto: ONE_YOCTO }],
});

export const setLimitsTx = (policyId: string, limits: LimitsJson): NearTx => ({
  receiverId: policyId,
  calls: [{ methodName: "set_limits", args: { limits }, gasTgas: POLICY.gas.owner, depositYocto: ONE_YOCTO }],
});

export const withdrawNearTx = (policyId: string, amountYocto: bigint): NearTx => ({
  receiverId: policyId,
  calls: [{ methodName: "withdraw_near", args: { amount: amountYocto.toString() }, gasTgas: POLICY.gas.owner, depositYocto: ONE_YOCTO }],
});

export const setAgentTx = (policyId: string, agent: string): NearTx => ({
  receiverId: policyId,
  calls: [{ methodName: "set_agent", args: { agent }, gasTgas: POLICY.gas.owner, depositYocto: ONE_YOCTO }],
});

export const setOnBehalfOfTx = (policyId: string, onBehalfOf: string): NearTx => ({
  receiverId: policyId,
  calls: [{ methodName: "set_on_behalf_of", args: { on_behalf_of: onBehalfOf }, gasTgas: POLICY.gas.owner, depositYocto: ONE_YOCTO }],
});

/** Deletes the policy and sends ALL its NEAR to the owner (no beneficiary argument exists). */
export const closeTx = (policyId: string): NearTx => ({
  receiverId: policyId,
  calls: [{ methodName: "close", args: {}, gasTgas: POLICY.gas.close, depositYocto: ONE_YOCTO }],
});

export const activateTx = (policyId: string): NearTx => ({
  receiverId: policyId,
  calls: [{ methodName: "activate", args: {}, gasTgas: POLICY.gas.activate, depositYocto: "0" }],
});

/** K.2 `create_policy`: the owner is the signer; the factory takes no owner, agent or name argument. */
export const createPolicyTx = (factoryId: string, chain: string, onBehalfOf: string, limits: LimitsJson, depositYocto: bigint): NearTx => ({
  receiverId: factoryId,
  calls: [{ methodName: "create_policy", args: { chain, on_behalf_of: onBehalfOf, limits }, gasTgas: POLICY.gas.createPolicy, depositYocto: depositYocto.toString() }],
});

/** K.2 `claim_refund`: pays the signer whatever a failed create could not return at once. */
export const claimRefundTx = (factoryId: string): NearTx => ({
  receiverId: factoryId,
  calls: [{ methodName: "claim_refund", args: {}, gasTgas: 30, depositYocto: "0" }],
});

// ---- Error codes (C.x): the web maps the ERR_ prefix to a message and keeps the raw text -----

const ERROR_MESSAGES: Record<string, string> = {
  ERR_NOT_OWNER: "Only the policy owner can do this. Switch to the owner account in your NEAR wallet.",
  ERR_WITHDRAW_FAILED: "The USDC transfer failed and nothing moved. Check the policy's USDC balance and that your account is registered on the USDC token.",
  ERR_ALREADY_ACTIVATED: "The policy is already activated.",
  ERR_DERIVE_FAILED: "The policy could not derive its loan-chain address from v1.signer. Try again in a moment.",
  ERR_NOT_ENOUGH_GAS: "The wallet attached too little gas. Retry, and do not lower the gas in your wallet.",
  ERR_ZERO_AMOUNT: "The amount must be more than zero.",
  ERR_NOT_PAUSED: "Pause the policy first, then close it.",
  ERR_CLOSE_TOO_SOON: "Wait one hour after the last rescue, approval or bridge request, then try again.",
  ERR_CLOSE_USDC_LEFT: "Withdraw the policy's USDC first, then close it.",
  ERR_CLOSE_FAILED: "The policy could not read its USDC balance. Nothing changed; try again.",
  ERR_MAX_PER_RESCUE_ABOVE_DAILY_CAP: "Max per rescue cannot be above the daily cap.",
  ERR_TARGET_HF_NOT_ABOVE_TRIGGER: "The target health factor must be higher than the trigger.",
  ERR_DEPOSIT_TOO_LOW: "The deposit was too low. Reload the page and try again.",
  ERR_TOO_MANY_VAULTS: "You've reached the limit of 8 vaults. Close one to open another.",
  ERR_CREATE_FAILED: "Your vault wasn't created and your NEAR was returned (or is waiting for you to claim).",
  ERR_NO_REFUND: "There is no refund waiting for this account.",
  ERR_UNKNOWN_CHAIN: "That chain isn't supported by the vault service.",
  ERR_EVM_ADDRESS_ZERO: "The loan address can't be the zero address.",
};

export function explainContractError(text: string): { code: string | null; message: string } {
  const code = /\bERR_[A-Z0-9_]+/.exec(text)?.[0] ?? null;
  return { code, message: code ? (ERROR_MESSAGES[code] ?? `The contract refused: ${code}.`) : "The transaction failed." };
}
