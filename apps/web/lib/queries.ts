"use client";

/** react-query hooks over the read layer. Polls only while the tab is visible; backs off after failures (matrix row 13). */
import { useQueries, useQuery } from "@tanstack/react-query";
import type { LoanChain } from "@backstop/config/registry";
import type { Address } from "viem";
import { z } from "zod";
import { NearRpcError, viewAccount, viewFunction } from "@/lib/near-rpc";
import { resolveChain } from "@/lib/chain";
import { readDebt, readLoan } from "@/lib/loan-client";
import { factoryMatchesSite, readFactory, readOwnerPolicies, readRefund } from "@/lib/factory-client";
import { vaultStatusResponseSchema, type VaultStatusResponse } from "@/lib/vault-status";
import { PUBLIC_ENV } from "@/lib/public-env";
import { configSchema, readExpectedCodeHash, readPolicy, readUsdcStorage, readUsdcBalance, verifyPolicy } from "@/lib/policy-client";

const POLL_MS = 30_000;
const backoff = (failures: number) => POLL_MS * 2 ** Math.min(failures, 2);

export function usePolicy(policyId: string | null) {
  return useQuery({
    queryKey: ["policy", policyId],
    enabled: policyId !== null,
    queryFn: async () => {
      const snap = await readPolicy(policyId!);
      const expected = await readExpectedCodeHash().catch(() => null);
      return { snap, checks: verifyPolicy(snap, expected) };
    },
    refetchInterval: (q) => backoff(q.state.fetchFailureCount),
    // "does not exist" / wrong-shape answers are definitive: do not hammer the RPC.
    retry: (count, err) => !(err instanceof NearRpcError && err.kind === "rejected") && !(err instanceof z.ZodError) && count < 2,
  });
}

export function useFactoryPolicies(owner: string | null) {
  const factory = PUBLIC_ENV.factoryId;
  return useQuery({
    queryKey: ["factory-policies", factory, owner],
    enabled: Boolean(factory && owner),
    // Closed vaults stay in the factory's index: only accounts that still exist are listed.
    queryFn: async () => {
      const ids = await readOwnerPolicies(factory!, owner!);
      const alive = await Promise.all(ids.map((id) => viewAccount(id).then((a) => a !== null)));
      return ids.filter((_, i) => alive[i]);
    },
    refetchInterval: (q) => backoff(q.state.fetchFailureCount),
  });
}

/** Aave position and balances on the policy's loan chain. The key carries the chain id so two chains never share a cache entry. */
export function useLoan(chain: LoanChain, derived: Address | null, borrower: Address | null) {
  return useQuery({
    queryKey: ["loan", chain.chainId, derived, borrower],
    enabled: borrower !== null,
    queryFn: () => readLoan(chain, derived, borrower!),
    refetchInterval: (q) => backoff(q.state.fetchFailureCount),
  });
}

export type PolicyChain = { id: string; chain: LoanChain | null; owner: string | null; state: "loading" | "ok" | "error" };

/** The loan chain and owner of each known policy (chain_id never changes after creation, so it is cached for good). */
export function usePolicyChains(ids: readonly string[]): PolicyChain[] {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ["policy-config", id],
      staleTime: Infinity,
      retry: 1,
      queryFn: () => viewFunction(id, "get_config", {}, configSchema),
    })),
    combine: (results) =>
      results.map((r, i): PolicyChain => {
        const id = ids[i]!;
        if (r.data) return { id, chain: resolveChain(r.data.chain_id), owner: r.data.owner, state: "ok" };
        return { id, chain: null, owner: null, state: r.isError ? "error" : "loading" };
      }),
  });
}

/** The connected NEAR account's NEAR balance, USDC balance and USDC registration (inputs to preflight checks). */
export function useNearAccount(accountId: string | null) {
  return useQuery({
    queryKey: ["near-account", accountId],
    enabled: accountId !== null,
    queryFn: async () => {
      const [account, usdc, storage] = await Promise.all([viewAccount(accountId!), readUsdcBalance(accountId!), readUsdcStorage(accountId!)]);
      return { nearBalance: account?.amount ?? 0n, usdc, usdcRegistered: storage !== null };
    },
    refetchInterval: (q) => backoff(q.state.fetchFailureCount),
  });
}

/** The factory and its checks against this site (K.6). Disabled when no factory is configured. */
export function useFactory() {
  const factoryId = PUBLIC_ENV.factoryId;
  return useQuery({
    queryKey: ["factory", factoryId],
    enabled: factoryId !== undefined,
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      const info = await readFactory(factoryId!);
      return { info, verdict: factoryMatchesSite(info) };
    },
  });
}

/** NEAR the factory holds for `owner` after a create that could not refund at once (0n = none). */
export function useRefund(owner: string | null) {
  const factoryId = PUBLIC_ENV.factoryId;
  return useQuery({
    queryKey: ["factory-refund", factoryId, owner],
    enabled: factoryId !== undefined && owner !== null,
    queryFn: () => readRefund(factoryId!, owner!),
    refetchInterval: (q) => backoff(q.state.fetchFailureCount),
  });
}

/** The kind of Aave debt `address` has on `chain`; disabled until the address is valid. */
export function useDebt(chain: LoanChain, address: Address | null) {
  return useQuery({
    queryKey: ["debt", chain.chainId, address],
    enabled: address !== null,
    staleTime: 15_000,
    retry: 1,
    queryFn: () => readDebt(chain, address!),
  });
}

/** The rescue bot's latest check of a vault, with its age by the server's clock. Failure = no proof of watching. */
export function useVaultStatus(policyId: string | null) {
  return useQuery<VaultStatusResponse>({
    queryKey: ["vault-status", policyId],
    enabled: policyId !== null,
    refetchInterval: 20_000,
    retry: 1,
    queryFn: async () => {
      const res = await fetch(`/api/vault-status?policy=${encodeURIComponent(policyId!)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return vaultStatusResponseSchema.parse(await res.json());
    },
  });
}
