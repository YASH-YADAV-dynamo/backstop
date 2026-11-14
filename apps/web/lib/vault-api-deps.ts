/** Real dependencies of /api/vaults. Server only: opens the request store (Postgres when DATABASE_URL is set, else VAULT_REQUESTS_FILE). No key of any kind. */
import { loadWebEnv, rpcList } from "@backstop/config";
import { NEAR } from "@backstop/config/registry";
import { openVaultRequestStore, type VaultRequestStore } from "@backstop/db";
import { accessKeys, configureNearRpc, viewAccount } from "@/lib/near-rpc";
import { PUBLIC_ENV } from "@/lib/public-env";
import type { VaultApiDeps } from "@/lib/vault-api";

let store: Promise<VaultRequestStore> | undefined;

function openStore(): Promise<VaultRequestStore> {
  store ??= openVaultRequestStore(loadWebEnv()).catch((err: unknown) => {
    store = undefined; // retry the connection on the next request
    throw err;
  });
  return store;
}

export function realVaultDeps(): VaultApiDeps {
  configureNearRpc(rpcList(loadWebEnv().NEAR_RPC_URL, NEAR.rpcUrls));
  return {
    store: openStore,
    account: viewAccount,
    accessKeys,
    deployerPublicKey: PUBLIC_ENV.vaultDeployerPk,
    codeHash: PUBLIC_ENV.policyCodeHash,
    allowedOwners: loadWebEnv().VAULT_ALLOWED_OWNERS ?? null,
    now: () => new Date(),
  };
}
