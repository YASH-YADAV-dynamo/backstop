/**
 * Typed reads of the vault factory (K.2) and the checks that must pass before the app lets anyone create a vault
 * through it (K.6). zod validates every answer; nothing here signs or sends.
 */
import { FEE, LOAN_CHAINS, type LoanChain } from "@backstop/config/registry";
import { z } from "zod";
import { accessKeyCount, viewFunction } from "@/lib/near-rpc";

const uint = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform((v) => BigInt(v));

const chainConfigSchema = z.object({
  key: z.string(),
  chain_id: z.number(),
  aave_pool: z.string(),
  usdc: z.string(),
  bridge_dest_asset: z.string(),
});

export const factoryConfigSchema = z.object({
  chains: z.array(chainConfigSchema),
  usdc_near: z.string(),
  bridge_signer_pk: z.string(),
  mpc_contract: z.string(),
  derivation_path: z.string(),
  default_agent: z.string(),
  fee_account: z.string(),
  fee_bps: z.number(),
});

export type FactoryConfig = z.infer<typeof factoryConfigSchema>;

export type FactoryInfo = {
  factoryId: string;
  config: FactoryConfig;
  /** yoctoNEAR the owner attaches to `create_policy`; computed on chain. */
  minDeposit: bigint;
  codeHash: string;
  keyCount: number;
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Everything the create review needs, read fresh from the chain. */
export async function readFactory(factoryId: string): Promise<FactoryInfo> {
  const [config, minDeposit, codeHash, keyCount] = await Promise.all([
    viewFunction(factoryId, "get_config", {}, factoryConfigSchema),
    viewFunction(factoryId, "min_deposit", {}, uint),
    viewFunction(factoryId, "policy_code_hash", {}, z.string().regex(/^[0-9a-fA-F]{64}$/)),
    accessKeyCount(factoryId),
  ]);
  return { factoryId, config, minDeposit, codeHash: codeHash.toLowerCase(), keyCount };
}

/** Owner's vaults that still exist are filtered by the caller; this is the raw index answer. */
export const readOwnerPolicies = (factoryId: string, owner: string) => viewFunction(factoryId, "get_policies", { owner }, z.array(z.string()));

/** Money waiting for the owner after a failed create that the factory could not refund at once. */
export const readRefund = (factoryId: string, owner: string) => viewFunction(factoryId, "get_refund", { owner }, uint);

export type FactoryVerdict = { ok: true; chains: LoanChain[] } | { ok: false; reason: string };

/**
 * K.6: every factory chain that the site also runs must match chain id, Aave pool, USDC and the bridge asset; the fee is at
 * most the cap and the factory has no access keys. One mismatch refuses creation for everyone.
 */
export function factoryMatchesSite(info: Pick<FactoryInfo, "config" | "keyCount">, siteChains: readonly LoanChain[] = LOAN_CHAINS): FactoryVerdict {
  if (info.keyCount !== 0) {
    return { ok: false, reason: "Vault creation is paused: the service that opens vaults failed a safety check. Nothing was sent." };
  }
  if (info.config.fee_bps > FEE.maxBps) {
    return { ok: false, reason: "Vault creation is paused: the service fee is above the allowed limit. Nothing was sent." };
  }
  const usable: LoanChain[] = [];
  for (const fc of info.config.chains) {
    const site = siteChains.find((c) => c.key === fc.key || c.chainId === fc.chain_id);
    if (!site) continue;
    const matches =
      site.key === fc.key && site.chainId === fc.chain_id && same(site.aave.pool, fc.aave_pool) && same(site.aave.usdc, fc.usdc) && site.usdcAssetId === fc.bridge_dest_asset;
    if (!matches) return { ok: false, reason: `Vault creation is paused: the ${site.name} settings do not match this website. Nothing was sent.` };
    usable.push(site);
  }
  if (usable.length === 0) return { ok: false, reason: "Vault creation is paused: no supported chain is set up yet. Nothing was sent." };
  // Base first, then the registry order.
  usable.sort((a, b) => siteChains.indexOf(a) - siteChains.indexOf(b));
  return { ok: true, chains: usable };
}
