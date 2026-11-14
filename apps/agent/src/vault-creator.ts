/**
 * Factory-less vault creation, bot side. The user's wallet already created the vault account
 * `bkst-<commitment>.near` with ONE full-access key: the bot's deploy key (VAULT_DEPLOYER_PRIVATE_KEY),
 * and funded it. For each open request the bot re-checks everything, then sends ONE transaction signed
 * by that key on the vault account: DeployContract(policy wasm), new(...), activate, DeleteKey(deploy
 * key). Actions in one receipt are atomic, so the account is either untouched or deployed and keyless.
 *
 *   - The commitment is recomputed: fields that do not hash to the vault id are never deployed.
 *   - The account must have no code, exactly the deploy key, and at least the creation budget.
 *   - A vault already deployed with the published code and no keys is only admitted.
 *   - Failures count; after `maxAttempts` the bot deletes the account (DeleteAccount, beneficiary =
 *     the request's owner) while it still holds the deploy key, so the owner gets the NEAR back.
 *   - After the deploy the bot runs the same admission as for every vault, and marks the request ready.
 * All I/O goes through CreatorIO (live wiring in service-live.ts), so this is tested with fakes.
 * Nothing here logs or returns a key.
 */
import { KeyPair, PublicKey, actions, teraToGas, type Action, type KeyPairString } from "near-api-js";
import { getAddress, sha256 } from "viem";
import { LOAN_CHAINS, NEW_TGAS, POLICY, isNearAccountId, policyInitArgs, vaultCreateDeposit, type LoanChain } from "@backstop/config";
import { matchesCommitment, type LimitsJson } from "@backstop/core";
import type { VaultRequest, VaultRequestPatch, VaultRequestStore } from "@backstop/db";
import type { Admission } from "./discover.js";

/** The vault account as the chain shows it. */
export interface CreatorAccount {
  /** yoctoNEAR */
  balance: bigint;
  /** sha256 of the deployed code, 64 lowercase hex; null when no contract is deployed. */
  codeHashHex: string | null;
  keys: { publicKey: string; fullAccess: boolean }[];
}

export interface CreatorIO {
  now(): Date;
  log(line: string): void;
  store: Pick<VaultRequestStore, "listPending" | "update">;
  /** null when the account does not exist. */
  account(vaultId: string): Promise<CreatorAccount | null>;
  usdcRegistered(vaultId: string): Promise<boolean>;
  /** USDC `storage_deposit` for the vault, signed by the deploy key on the vault account. Returns the tx hash. */
  registerUsdc(vaultId: string): Promise<string>;
  /** Sends `actions` from the vault account, signed by the deploy key. Returns the tx hash. */
  sendAsVault(vaultId: string, txActions: Action[]): Promise<string>;
  /** `activate` (anyone may call it), sent by the bot account. */
  activate(vaultId: string): Promise<void>;
  admit(vaultId: string): Promise<Admission>;
}

export interface CreatorConfig {
  /** ed25519 public key of VAULT_DEPLOYER_PRIVATE_KEY, as NEAR prints it. */
  deployerPublicKey: string;
  /** The policy wasm the bot deploys; its sha256 equals `codeHash` (checked at start). */
  code: Uint8Array;
  /** Published policy code hash, 64 lowercase hex. */
  codeHash: string;
  /** AGENT_ACCOUNT_ID: every created vault names this bot as its agent. */
  botAccountId: string;
  feeAccount: string;
  feeBps: number;
  /** Failed attempts before the account is deleted and the owner refunded. */
  maxAttempts: number;
  /** A deployed vault that is still not activated after this long gets an `activate` call from the bot. */
  activateAfterMs: number;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_ACTIVATE_AFTER_MS = 300_000;

export interface CreatorEnv {
  VAULT_DEPLOYER_PRIVATE_KEY?: string | undefined;
  NEXT_PUBLIC_VAULT_DEPLOYER_PK?: string | undefined;
  POLICY_WASM_PATH?: string | undefined;
  FEE_ACCOUNT_ID?: string | undefined;
  FEE_BPS: number;
}

/**
 * The creator's config from the environment, or null when VAULT_DEPLOYER_PRIVATE_KEY is not set (creation
 * off). Refuses to start on a wasm whose sha256 is not the published code hash, or a deploy key whose
 * public half is not the one the website gives users. Returns only the public key, never the private one.
 */
export async function creatorConfig(
  env: CreatorEnv,
  codeHash: string,
  botAccountId: string,
  readWasm: (path: string) => Promise<Uint8Array>,
): Promise<CreatorConfig | null> {
  if (!env.VAULT_DEPLOYER_PRIVATE_KEY) return null;
  if (!env.POLICY_WASM_PATH) throw new Error("Vault creation needs POLICY_WASM_PATH (the policy wasm to deploy) in .env, or unset VAULT_DEPLOYER_PRIVATE_KEY.");
  if (!env.FEE_ACCOUNT_ID) throw new Error("Vault creation needs FEE_ACCOUNT_ID (the service fee recipient written into each vault) in .env.");
  let deployerPublicKey: string;
  try {
    deployerPublicKey = KeyPair.fromString(env.VAULT_DEPLOYER_PRIVATE_KEY as KeyPairString).getPublicKey().toString();
  } catch {
    throw new Error("VAULT_DEPLOYER_PRIVATE_KEY is not a valid ed25519 private key. Generate one with near-cli and store it in the host secret store.");
  }
  if (env.NEXT_PUBLIC_VAULT_DEPLOYER_PK !== undefined && env.NEXT_PUBLIC_VAULT_DEPLOYER_PK !== deployerPublicKey) {
    throw new Error(`NEXT_PUBLIC_VAULT_DEPLOYER_PK is not the public key of VAULT_DEPLOYER_PRIVATE_KEY (that is ${deployerPublicKey}). Users would add a key the bot cannot sign with; fix one of them.`);
  }
  const code = await readWasm(env.POLICY_WASM_PATH);
  const hash = sha256(code).slice(2);
  if (hash !== codeHash) {
    throw new Error(`POLICY_WASM_PATH hashes to ${hash}, not the published policy code hash ${codeHash}. Deploy only the published wasm: fix the path or the hash.`);
  }
  return {
    deployerPublicKey,
    code,
    codeHash,
    botAccountId,
    feeAccount: env.FEE_ACCOUNT_ID,
    feeBps: env.FEE_BPS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    activateAfterMs: DEFAULT_ACTIVATE_AFTER_MS,
  };
}

/** The one deploy transaction, on the vault account: code, init, activate, then the deploy key is deleted. Never AddKey or Transfer. */
export function vaultDeployActions(code: Uint8Array, initArgs: Record<string, unknown>, deployerPublicKey: string): Action[] {
  return [
    actions.deployContract(code),
    actions.functionCall("new", initArgs, teraToGas(NEW_TGAS), 0n),
    actions.functionCall("activate", {}, teraToGas(POLICY.gas.activate), 0n),
    actions.deleteKey(PublicKey.fromString(deployerPublicKey)),
  ];
}

/** Gives up on a vault: deletes the account and sends every yoctoNEAR on it to `owner`. */
export const vaultAbortActions = (owner: string): Action[] => [actions.deleteAccount(owner)];

/** Mirrors `Limits::validate` in the contract, plus "trigger above 1.00". null = valid. */
export function limitsProblem(l: LimitsJson): string | null {
  if (l.trigger_hf_bps <= 10_000) return "the trigger health factor must be above 1.00";
  if (l.target_hf_bps <= l.trigger_hf_bps) return "the target health factor must be above the trigger";
  const maxPer = BigInt(l.max_per_rescue);
  if (maxPer === 0n) return "max per rescue must be above 0";
  if (maxPer > BigInt(l.daily_cap)) return "max per rescue must not be above the daily cap";
  if (l.cooldown_secs === 0) return "the cooldown must be above 0";
  if (BigInt(l.max_fee_per_gas) === 0n) return "the max fee per gas must be above 0";
  if (BigInt(l.max_gas_limit) === 0n) return "the max gas limit must be above 0";
  return null;
}

/** The request's chain and `new` args, or why they are not acceptable. */
export function requestPlan(r: VaultRequest, cfg: Pick<CreatorConfig, "botAccountId" | "feeAccount" | "feeBps">): { ok: true; chain: LoanChain; initArgs: Record<string, unknown> } | { ok: false; problem: string } {
  const chain = LOAN_CHAINS.find((c) => c.key === r.chainKey);
  if (!chain) return { ok: false, problem: `chain "${r.chainKey}" is not supported` };
  if (!isNearAccountId(r.owner)) return { ok: false, problem: "the owner is not a NEAR account id" };
  let checksummed: string;
  try {
    checksummed = getAddress(r.borrower);
  } catch {
    return { ok: false, problem: "the loan address is not an EVM address" };
  }
  if (checksummed !== r.borrower) return { ok: false, problem: "the loan address is not in checksum form" };
  const bad = limitsProblem(r.limits);
  if (bad) return { ok: false, problem: bad };
  return {
    ok: true,
    chain,
    initArgs: policyInitArgs({ chain, owner: r.owner, agent: cfg.botAccountId, borrower: r.borrower, limits: r.limits, feeAccount: cfg.feeAccount, feeBps: cfg.feeBps }),
  };
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 500);

/**
 * Works through every open request once, oldest first, and returns how many became ready. Never throws:
 * each failure is recorded on its request.
 */
export async function processVaultRequests(io: CreatorIO, cfg: CreatorConfig): Promise<number> {
  let open: VaultRequest[];
  try {
    open = await io.store.listPending();
  } catch (err) {
    io.log(`Vault creation: could not list requests (${errText(err)}).`);
    return 0;
  }
  let ready = 0;
  for (const r of open) {
    try {
      if (await processOne(io, cfg, r)) ready += 1;
    } catch (err) {
      await recordFailure(io, cfg, r, errText(err));
    }
  }
  return ready;
}

async function update(io: CreatorIO, r: VaultRequest, patch: VaultRequestPatch): Promise<void> {
  await io.store.update(r.vaultId, patch, io.now());
}

/** An attempt failed: count it; once the budget of attempts is spent, refund the owner if the deploy key still allows it. */
async function recordFailure(io: CreatorIO, cfg: CreatorConfig, r: VaultRequest, message: string): Promise<void> {
  const attempts = r.attempts + 1;
  io.log(`Vault ${r.vaultId}: attempt ${attempts} of ${cfg.maxAttempts} failed: ${message}`);
  try {
    await update(io, r, { attempts, lastError: message });
    if (attempts >= cfg.maxAttempts) await giveUp(io, cfg, { ...r, attempts }, `gave up after ${attempts} attempts: ${message}`);
  } catch (err) {
    io.log(`Vault ${r.vaultId}: could not record the failure (${errText(err)}); it is retried on the next pass.`);
  }
}

/**
 * Ends a request that cannot be deployed. While the account still holds the deploy key the bot deletes it
 * (beneficiary = owner) and marks the request aborted; otherwise there is nothing the bot can return and the
 * request is failed. If the abort transaction itself fails, the request stays open and is retried next pass.
 */
async function giveUp(io: CreatorIO, cfg: CreatorConfig, r: VaultRequest, reason: string): Promise<void> {
  const acct = await io.account(r.vaultId);
  const key = acct?.keys.find((k) => k.publicKey === cfg.deployerPublicKey && k.fullAccess);
  if (!acct || !key) {
    await update(io, r, { status: "failed", lastError: reason });
    io.log(`Vault ${r.vaultId}: failed (${reason}). The deploy key is not on the account, so nothing was returned automatically.`);
    return;
  }
  try {
    const tx = await io.sendAsVault(r.vaultId, vaultAbortActions(r.owner));
    await update(io, r, { status: "aborted", lastError: reason });
    io.log(`Vault ${r.vaultId}: deleted, its NEAR returned to ${r.owner} (tx ${tx}). Reason: ${reason}`);
  } catch (err) {
    await update(io, r, { lastError: `${reason}; refund failed: ${errText(err)}` });
    io.log(`Vault ${r.vaultId}: refund to ${r.owner} failed (${errText(err)}); retrying next pass.`);
  }
}

/** One request, one step further. Resolves true when it became ready; throws when the attempt failed. */
async function processOne(io: CreatorIO, cfg: CreatorConfig, r: VaultRequest): Promise<boolean> {
  // 1. The fields must hash to the vault id; otherwise the owner (the refund target) is unproven: touch nothing.
  const commitment = { owner: r.owner, chainKey: r.chainKey, borrower: r.borrower, limits: r.limits, salt: r.salt };
  if (!(await matchesCommitment(r.vaultId, commitment))) {
    await update(io, r, { status: "failed", lastError: "the request's fields do not match its vault name; nothing was deployed" });
    io.log(`Vault ${r.vaultId}: refused, fields do not match the vault name.`);
    return false;
  }
  if (r.attempts >= cfg.maxAttempts) {
    await giveUp(io, cfg, r, r.lastError ?? `gave up after ${r.attempts} attempts`);
    return false;
  }
  // 2. Chain, loan address and limits as the contract would accept them.
  const plan = requestPlan(r, cfg);
  if (!plan.ok) {
    await giveUp(io, cfg, r, `not created: ${plan.problem}`);
    return false;
  }
  // 3. The account as it is on chain now.
  const acct = await io.account(r.vaultId);
  if (!acct) {
    await update(io, r, { status: "failed", lastError: "the vault account does not exist (it was never created or was deleted); nothing to deploy or return" });
    return false;
  }
  const deployKey = acct.keys.find((k) => k.publicKey === cfg.deployerPublicKey && k.fullAccess);
  if (acct.codeHashHex !== null) {
    if (acct.codeHashHex === cfg.codeHash && acct.keys.length === 0) return admitAndFinish(io, cfg, r);
    const what = acct.codeHashHex !== cfg.codeHash ? `unexpected contract code ${acct.codeHashHex}` : `${acct.keys.length} access key(s) next to the contract`;
    if (deployKey) await giveUp(io, cfg, r, `not created: the account has ${what}`);
    else await update(io, r, { status: "failed", lastError: `the account has ${what}; Backstop cannot use or return it` });
    return false;
  }
  if (!deployKey || acct.keys.length !== 1) {
    await update(io, r, { status: "failed", lastError: "the account's keys are not exactly the Backstop deploy key; Backstop did not touch it" });
    return false;
  }
  const need = vaultCreateDeposit(cfg.code.length);
  if (acct.balance < need) {
    await giveUp(io, cfg, r, `not created: the account holds ${acct.balance} yoctoNEAR, the vault needs ${need}`);
    return false;
  }
  // 4. Deploy: USDC registration first (paid from the vault's balance), then the one atomic deploy transaction.
  if (r.status === "pending") await update(io, r, { status: "deploying" });
  if (!(await io.usdcRegistered(r.vaultId))) {
    const reg = await io.registerUsdc(r.vaultId);
    io.log(`Vault ${r.vaultId}: registered on NEAR USDC (tx ${reg}).`);
  }
  const tx = await io.sendAsVault(r.vaultId, vaultDeployActions(cfg.code, plan.initArgs, cfg.deployerPublicKey));
  io.log(`Vault ${r.vaultId}: policy deployed for ${r.owner} on ${plan.chain.name}, deploy key deleted (tx ${tx}).`);
  await update(io, r, { lastError: null });
  return admitAndFinish(io, cfg, { ...r, status: "deploying", lastError: null, updatedAt: io.now().toISOString() });
}

/** A deployed, keyless vault: admitted means ready; not activated yet means wait (then nudge); any other refusal is final. */
async function admitAndFinish(io: CreatorIO, cfg: CreatorConfig, r: VaultRequest): Promise<boolean> {
  const a = await io.admit(r.vaultId);
  if (a.ok) {
    await update(io, r, { status: "ready", lastError: null });
    io.log(`Vault ${r.vaultId}: ready (rescue wallet ${a.config.baseAddress}).`);
    return true;
  }
  if (a.reason === "UNREADABLE") throw new Error(a.message);
  if (a.reason === "NOT_ACTIVATED") {
    if (r.status === "pending") await update(io, r, { status: "deploying" });
    if (io.now().getTime() - Date.parse(r.updatedAt) < cfg.activateAfterMs) return false; // the deploy transaction's own activate is on its way
    await io.activate(r.vaultId);
    // Counted like a failure, so a vault that never activates ends as failed instead of costing bot gas forever.
    throw new Error("the vault was not activated yet; the bot called activate (anyone can)");
  }
  await update(io, r, { status: "failed", lastError: `deployed but refused by the bot (${a.reason}): ${a.message}` });
  return false;
}

