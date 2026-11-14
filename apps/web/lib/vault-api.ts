/**
 * /api/vaults logic (factory-less vault creation), with every network and storage dependency injected so the
 * tests run it offline. POST registers an account the user's wallet just created for the bot to deploy into;
 * it is accepted only when the submitted fields hash to the vault id and the chain shows exactly the account
 * those fields describe. GET lists an owner's requests or shows one. Holds no key and signs nothing.
 */
import { LOAN_CHAINS } from "@backstop/config/registry";
import { MAX_VAULTS_PER_OWNER } from "@backstop/config/vault-plan";
import { canonicalLimits, isVaultName, matchesCommitment, type LimitsJson } from "@backstop/core";
import { formatUnits } from "viem";
import type { AccessKeyInfo, AccountInfo } from "@/lib/near-rpc";
import { redactUrls } from "@/lib/redact";
import { isNearAccountId, hexToNearCodeHash, parseEvmAddress, parseLimits } from "@/lib/validate";
import { createBodySchema, inviteOnlyMessage, type CreateBody, type RequestView } from "@/lib/vault-requests";

/** A stored request as the store returns it (the fields of @backstop/db's VaultRequest the API uses). */
export type StoredRequest = CreateBody & { status: RequestView["status"]; lastError: string | null; createdAt: string; updatedAt: string };

export type VaultApiStore = {
  insertIfAbsent(req: CreateBody, now: Date): Promise<{ request: StoredRequest; inserted: boolean }>;
  get(vaultId: string): Promise<StoredRequest | null>;
  listByOwner(owner: string): Promise<StoredRequest[]>;
};

export type VaultApiDeps = {
  store: () => Promise<VaultApiStore>;
  /** null = the account does not exist. */
  account: (accountId: string) => Promise<AccountInfo | null>;
  /** null = the account does not exist. */
  accessKeys: (accountId: string) => Promise<AccessKeyInfo[] | null>;
  /** NEXT_PUBLIC_VAULT_DEPLOYER_PK; undefined = creation is off. */
  deployerPublicKey: string | undefined;
  /** NEXT_PUBLIC_POLICY_CODE_HASH (64 hex); undefined = creation is off. */
  codeHash: string | undefined;
  /** VAULT_ALLOWED_OWNERS (lowercase NEAR accounts); null = no allowlist, creation is open. */
  allowedOwners: readonly string[] | null;
  now: () => Date;
};

export type ApiResult = { status: number; body: unknown };

const fail = (status: number, error: string): ApiResult => ({ status, body: { error } });

/** NEAR's code_hash of an account without a contract. */
const NO_CODE = "11111111111111111111111111111111";

export const view = (r: StoredRequest): RequestView => ({
  vaultId: r.vaultId,
  owner: r.owner,
  chainKey: r.chainKey,
  status: r.status,
  lastError: r.lastError,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** The limits through the same validator as the create form, so the API accepts exactly what the form can produce. */
export function limitsProblem(l: LimitsJson): string | null {
  const parsed = parseLimits({
    triggerHf: formatUnits(BigInt(l.trigger_hf_bps), 4),
    targetHf: formatUnits(BigInt(l.target_hf_bps), 4),
    maxPerRescue: formatUnits(BigInt(l.max_per_rescue), 6),
    dailyCap: formatUnits(BigInt(l.daily_cap), 6),
    cooldownSecs: String(l.cooldown_secs),
    maxFeeGwei: formatUnits(BigInt(l.max_fee_per_gas), 9),
    maxGasLimit: l.max_gas_limit,
  });
  if (!parsed.ok) return parsed.error;
  return canonicalLimits(parsed.value) === canonicalLimits(l) ? null : "The limits are not in the contract's canonical form.";
}

const openStatus = (r: StoredRequest) => r.status !== "failed" && r.status !== "aborted";

export async function handleCreate(input: unknown, deps: VaultApiDeps): Promise<ApiResult> {
  if (!deps.deployerPublicKey || !deps.codeHash) return fail(503, "Vault creation is not open on this site yet.");
  const parsed = createBodySchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(400, `Bad request: ${first ? `${first.path.join(".") || "body"} ${first.message}` : "invalid body"}.`);
  }
  const req = parsed.data;
  if (deps.allowedOwners !== null && !deps.allowedOwners.includes(req.owner)) return fail(403, inviteOnlyMessage(req.owner));
  if (!LOAN_CHAINS.some((c) => c.key === req.chainKey)) return fail(400, `Bad request: chainKey must be one of ${LOAN_CHAINS.map((c) => c.key).join(", ")}.`);
  const address = parseEvmAddress(req.borrower);
  if (!address.ok || address.value !== req.borrower) return fail(400, "Bad request: borrower must be the checksummed 0x address of the loan.");
  const bad = limitsProblem(req.limits);
  if (bad) return fail(400, `Bad request: ${bad}`);
  const { vaultId, ...fields } = req;
  if (!(await matchesCommitment(vaultId, fields))) {
    return fail(400, "These details do not match the vault name they were created under. Nothing was registered; reload the page and check your vault.");
  }

  try {
    const store = await deps.store();
    const existing = await store.get(vaultId);
    if (!existing) {
      const mine = await store.listByOwner(req.owner);
      if (mine.filter(openStatus).length >= MAX_VAULTS_PER_OWNER) {
        return fail(409, `You've reached the limit of ${MAX_VAULTS_PER_OWNER} vaults. Close one to open another.`);
      }
      const chainProblem = await accountProblem(vaultId, deps);
      if (chainProblem) return fail(409, chainProblem);
    }
    // An existing row is only returned when every field is the same (the store throws otherwise).
    const { request, inserted } = await store.insertIfAbsent(req, deps.now());
    return { status: inserted ? 201 : 200, body: { request: view(request) } };
  } catch (err) {
    if (err instanceof Error && err.name === "VaultRequestConflictError") return fail(409, err.message);
    return fail(502, `The vault service could not save your request: ${redactUrls(err instanceof Error ? err.message.split("\n")[0]! : String(err))}. Try again in a moment.`);
  }
}

/** What the chain must show before the bot is asked to deploy: the account the user's wallet created, untouched. */
async function accountProblem(vaultId: string, deps: VaultApiDeps): Promise<string | null> {
  const [account, keys] = await Promise.all([deps.account(vaultId), deps.accessKeys(vaultId)]);
  if (!account || !keys) {
    return "Your vault account isn't on NEAR yet. If your wallet approved it, wait a few seconds and try again. If the name was taken, nothing was created and your NEAR was returned.";
  }
  if (account.codeHash !== NO_CODE) {
    if (account.codeHash === hexToNearCodeHash(deps.codeHash!) && keys.length === 0) return null;
    return "This account already runs other code or still has keys, so Backstop won't use it.";
  }
  const only = keys.length === 1 ? keys[0]! : null;
  if (!only || only.publicKey !== deps.deployerPublicKey || !only.fullAccess) {
    return "This account's keys are not exactly the Backstop setup key, so Backstop won't deploy into it.";
  }
  return null;
}

export async function handleGet(params: URLSearchParams, deps: Pick<VaultApiDeps, "store" | "allowedOwners">): Promise<ApiResult> {
  const owner = params.get("owner");
  const vault = params.get("vault");
  const allowed = params.get("allowed");
  if ([owner, vault, allowed].filter((p) => p !== null).length !== 1) return fail(400, "Add exactly one of ?owner=<NEAR account>, ?vault=<vault account> or ?allowed=<NEAR account>.");
  if (allowed !== null) {
    if (!isNearAccountId(allowed)) return fail(400, "The allowed parameter must be a NEAR account id (2-64 characters: lowercase letters, digits, - _ and dots).");
    // Only whether THIS account may create; the list itself never leaves the server.
    return { status: 200, body: { allowed: deps.allowedOwners === null || deps.allowedOwners.includes(allowed), inviteOnly: deps.allowedOwners !== null } };
  }
  if (owner !== null && !isNearAccountId(owner)) return fail(400, "The owner parameter must be a NEAR account id (2-64 characters: lowercase letters, digits, - _ and dots).");
  if (vault !== null && !isVaultName(vault)) return fail(400, "The vault parameter must be a vault account like bkst-<20 hex>.near.");
  try {
    const store = await deps.store();
    if (owner !== null) return { status: 200, body: { requests: (await store.listByOwner(owner)).map(view) } };
    const one = await store.get(vault!);
    return { status: 200, body: { request: one ? view(one) : null } };
  } catch (err) {
    return fail(502, `The vault service is unavailable: ${redactUrls(err instanceof Error ? err.message.split("\n")[0]! : String(err))}. Try again in a moment.`);
  }
}
