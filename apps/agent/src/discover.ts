/**
 * Vault discovery and admission for the bot service (design v3 1.1).
 * Discovery: factory `list_policies` paged up to `policy_count` (v2 K.2), plus POLICY_CONTRACT_IDS /
 * POLICY_CONTRACT_ID for operator-made vaults. Admission: the D.3 checks (`assertConfigMatches`), no
 * access keys at all (no rehearsal exception here), `agent` = the bot account, and the account's code
 * hash = the factory's `policy_code_hash()`. A refused vault is never called; the reason is published.
 */
import { z } from "zod";
import type { Address } from "viem";
import { FACTORY, loanChainById, type LoanChain } from "@backstop/config";
import type { Limits, PolicyStatus, VaultReason } from "@backstop/core";
import { assertConfigMatches } from "./checks.js";
import type { ActivePolicyConfig, PolicyConfig } from "./policy.js";

/** A NEAR view call returning raw JSON. */
export type ViewFn = (contractId: string, method: string, args?: Record<string, unknown>) => Promise<unknown>;

const u64 = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform((v) => Number(v));
const entrySchema = z.object({ policy: z.string().min(2).max(64), owner: z.string().min(2).max(64), chain: z.string() });
const factoryConfigSchema = z.object({ default_agent: z.string(), chains: z.array(z.object({ key: z.string(), chain_id: z.number().int() })) });

export interface FactoryEntry {
  policy: string;
  owner: string;
  chain: string;
}

function parseOr<S extends z.ZodTypeAny>(schema: S, raw: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Factory ${what} has an unexpected shape (${parsed.error.issues[0]?.message ?? "invalid"}). Check that FACTORY_CONTRACT_ID runs contracts/factory.`);
  }
  return parsed.data;
}

/** Every vault the factory created, oldest first, in pages of `list_policies`' maximum. */
export async function listFactoryVaults(view: ViewFn, factoryId: string, pageSize: number = FACTORY.listPageMax): Promise<FactoryEntry[]> {
  const count = parseOr(u64, await view(factoryId, "policy_count"), "policy_count");
  const out: FactoryEntry[] = [];
  for (let from = 0; from < count; from += pageSize) {
    const page = parseOr(z.array(entrySchema), await view(factoryId, "list_policies", { from_index: from, limit: pageSize }), "list_policies");
    if (page.length === 0) break;
    out.push(...page);
  }
  return out;
}

/** The factory's `policy_code_hash()` (64 lowercase hex) and `default_agent`. */
export async function readFactory(view: ViewFn, factoryId: string): Promise<{ codeHash: string; defaultAgent: string }> {
  const [hash, config] = await Promise.all([view(factoryId, "policy_code_hash"), view(factoryId, "get_config")]);
  const codeHash = parseOr(z.string().regex(/^[0-9a-f]{64}$/), hash, "policy_code_hash");
  return { codeHash, defaultAgent: parseOr(factoryConfigSchema, config, "get_config").default_agent };
}

export interface VaultSources {
  factoryId?: string | undefined;
  /** POLICY_CONTRACT_IDS plus POLICY_CONTRACT_ID. */
  policyIds: readonly string[];
}

/** Every vault id to watch, de-duplicated, factory vaults first. */
export async function discoverVaults(view: ViewFn, sources: VaultSources): Promise<string[]> {
  const fromFactory = sources.factoryId ? (await listFactoryVaults(view, sources.factoryId)).map((e) => e.policy) : [];
  return [...new Set([...fromFactory, ...sources.policyIds])];
}

/** What admission reads about one vault (live: NEAR RPC + chainsig.js + v1.signer view). */
export interface AdmitIO {
  readPolicy(policyId: string): Promise<{ config: PolicyConfig; limits: Limits; status: PolicyStatus }>;
  accessKeyCount(policyId: string): Promise<number>;
  /** sha256 of the deployed code, 64 lowercase hex. */
  codeHashHex(policyId: string): Promise<string>;
  /** The rescue wallet derived locally (chainsig.js) and by the `v1.signer.derived_public_key` view. */
  derive(chain: LoanChain, policyId: string): Promise<{ chainsig: Address; mpcView: Address }>;
}

export type Admission =
  | { ok: true; policyId: string; config: ActivePolicyConfig; limits: Limits }
  | { ok: false; policyId: string; chainId: number | null; reason: VaultReason; message: string };

export interface AdmitExpect {
  /** AGENT_ACCOUNT_ID: the bot account every admitted vault must name as `agent`. */
  botAccountId: string;
  /** The factory's policy_code_hash(); null when no factory is configured (operator vaults only). */
  codeHash: string | null;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs every admission check; never throws (an unreadable vault is refused as UNREADABLE). */
export async function admitVault(io: AdmitIO, policyId: string, expect: AdmitExpect): Promise<Admission> {
  const refuse = (reason: VaultReason, message: string, chainId: number | null = null): Admission => ({ ok: false, policyId, chainId, reason, message });
  let read: Awaited<ReturnType<AdmitIO["readPolicy"]>>;
  let keys: number;
  let codeHash: string;
  try {
    [read, keys, codeHash] = await Promise.all([io.readPolicy(policyId), io.accessKeyCount(policyId), io.codeHashHex(policyId)]);
  } catch (err) {
    return refuse("UNREADABLE", `could not read the vault: ${errText(err)}`);
  }
  const { config } = read;
  if (keys > 0) {
    return refuse("HAS_ACCESS_KEYS", `the vault account has ${keys} access key(s); whoever holds one bypasses every limit`, config.chainId);
  }
  if (config.agent !== expect.botAccountId) {
    return refuse("AGENT_MISMATCH", `agent is ${config.agent}, not this bot (${expect.botAccountId}); the owner can fix it with set_agent`, config.chainId);
  }
  if (expect.codeHash !== null && codeHash !== expect.codeHash) {
    return refuse("CODE_HASH_MISMATCH", `code hash is ${codeHash}, not the factory's policy_code_hash ${expect.codeHash}`, config.chainId);
  }
  if (config.baseAddress === null) {
    return refuse("NOT_ACTIVATED", "the vault is not activated yet; run activate on it (anyone can, 50 TGas)", config.chainId);
  }
  let chain: LoanChain;
  try {
    chain = loanChainById(config.chainId);
  } catch (err) {
    return refuse("CONFIG_MISMATCH", errText(err), config.chainId);
  }
  let derived: { chainsig: Address; mpcView: Address };
  try {
    derived = await io.derive(chain, policyId);
  } catch (err) {
    return refuse("UNREADABLE", `could not derive the rescue wallet: ${errText(err)}`, config.chainId);
  }
  try {
    const active = assertConfigMatches(config, {
      chainsigAddress: derived.chainsig,
      mpcViewAddress: derived.mpcView,
      accessKeyCount: keys,
      agentAccountId: expect.botAccountId,
    });
    return { ok: true, policyId, config: active, limits: read.limits };
  } catch (err) {
    return refuse("CONFIG_MISMATCH", errText(err).replace(/\nRefusing to run\.$/, ""), config.chainId);
  }
}
