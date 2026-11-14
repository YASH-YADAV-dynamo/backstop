"use client";

/** The selected policy, its verified snapshot, and the one ReviewDialog host every action goes through. */
import type { LoanChain } from "@backstop/config/registry";
import type { UseQueryResult } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ReviewDialog } from "@/components/wallet/review-dialog";
import { useNear } from "@/components/wallet/near-provider";
import { chainOrDefault } from "@/lib/chain";
import { mergeKnown, parsePolicyList, withChosen, without } from "@/lib/known-policies";
import { failedChecks, type Check, type PolicySnapshot } from "@/lib/policy-client";
import { PUBLIC_ENV } from "@/lib/public-env";
import { usePolicy, useVaultRequests } from "@/lib/queries";
import type { ReviewRequest } from "@/lib/review";
import type { RequestView } from "@/lib/vault-requests";
import { isNearAccountId } from "@/lib/validate";
import { useLocalString } from "@/lib/use-client";

type PolicyData = { snap: PolicySnapshot; checks: Check[] };

type Ctx = {
  /** Connected NEAR account, or null. */
  owner: string | null;
  policyId: string | null;
  /** Every policy known for this owner (vaults created here, saved on this device, site default). */
  known: string[];
  /** This owner's vault creation requests, every status (null until read). */
  requests: RequestView[] | null;
  /** Select a policy (and remember it). Selecting a policy on another chain switches the loan chain. */
  choose: (id: string) => void;
  /** Stop listing a policy on this device. */
  forget: (id: string) => void;
  query: UseQueryResult<PolicyData>;
  /** The loan chain of the loaded policy (the registry default until one is loaded, or if the policy names an unsupported chain). */
  chain: LoanChain;
  requestsError: boolean;
  /** The vault service is still listing this account's vaults. */
  requestsLoading: boolean;
  snap: PolicySnapshot | null;
  checks: Check[] | null;
  /** Connected account is the policy's owner. */
  owned: boolean;
  /** No failed verification checks. */
  verified: boolean;
  activated: boolean;
  paused: boolean;
  openReview: (request: ReviewRequest) => void;
  reviewOpen: boolean;
};

const PolicyContext = createContext<Ctx | null>(null);

export function usePolicyContext(): Ctx {
  const ctx = useContext(PolicyContext);
  if (!ctx) throw new Error("usePolicyContext must be used inside <PolicyProvider> (mounted by AppShell).");
  return ctx;
}

const withLegacy = (saved: string[], legacy: string | null): string[] => (legacy && isNearAccountId(legacy) && !saved.includes(legacy) ? [...saved, legacy] : saved);

export function PolicyProvider({ children }: { children: ReactNode }) {
  const nearWallet = useNear();
  const owner = nearWallet.state.status === "signed-in" ? nearWallet.state.accountId : null;
  const [savedRaw, setSavedRaw] = useLocalString(owner ? `backstop.policies.${owner}` : null);
  const [legacy, setLegacy] = useLocalString(owner ? `backstop.policy.${owner}` : null);
  const requests = useVaultRequests(owner);
  const [picked, setPicked] = useState<string | null>(null);
  const [review, setReview] = useState<{ id: number; policyId: string | null; request: ReviewRequest } | null>(null);

  // The single-policy key of earlier versions counts as the first saved policy; the first write replaces it.
  const saved = useMemo(() => withLegacy(parsePolicyList(savedRaw), legacy), [savedRaw, legacy]);
  const ready = useMemo(() => requests.data?.filter((r) => r.status === "ready").map((r) => r.vaultId), [requests.data]);
  const known = useMemo(() => mergeKnown(ready, saved, PUBLIC_ENV.policyId), [ready, saved]);
  const policyId = owner ? (picked ?? saved[0] ?? known[0] ?? null) : null;
  const query = usePolicy(policyId, owner);

  const store = useCallback(
    (next: string[]) => {
      setSavedRaw(JSON.stringify(next));
      setLegacy(null);
    },
    [setSavedRaw, setLegacy],
  );
  const choose = useCallback(
    (id: string) => {
      setPicked(id);
      setReview(null);
      store(withChosen(saved, id));
    },
    [saved, store],
  );
  const forget = useCallback(
    (id: string) => {
      setReview(null);
      setPicked((cur) => (cur === id ? null : cur));
      store(without(saved, id));
    },
    [saved, store],
  );
  const openReview = useCallback((request: ReviewRequest) => setReview((cur) => (cur ? cur : { id: Date.now(), policyId, request })), [policyId]);
  const closeReview = useCallback(() => setReview(null), []);

  // A review belongs to the policy it was opened for: switching policy closes it.
  const activeReview = review && review.policyId === policyId ? review : null;
  const snap = query.data?.snap ?? null;
  const chain = chainOrDefault(snap?.config.chain_id);
  const checks = query.data?.checks ?? null;
  const value = useMemo<Ctx>(
    () => ({
      owner,
      policyId,
      known,
      requests: requests.data ?? null,
      choose,
      forget,
      query,
      chain,
      requestsError: requests.isError,
      requestsLoading: requests.isLoading,
      snap,
      checks,
      owned: Boolean(snap && owner && snap.config.owner === owner),
      verified: checks !== null && failedChecks(checks).length === 0,
      activated: snap?.config.base_address != null,
      paused: snap?.limits.paused ?? false,
      openReview,
      reviewOpen: activeReview !== null,
    }),
    [owner, policyId, known, requests.data, chain, choose, forget, query, requests.isError, requests.isLoading, snap, checks, openReview, activeReview],
  );

  return (
    <PolicyContext.Provider value={value}>
      {children}
      {activeReview ? <ReviewDialog key={`${activeReview.id}:${activeReview.policyId}`} request={activeReview.request} loanChain={chain} onClose={closeReview} /> : null}
    </PolicyContext.Provider>
  );
}
