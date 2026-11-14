/** Real network dependencies for POST /api/near-topup/quote. Server only. Reuses the fund route's 1Click plumbing. */
import { verifyCanonicalQuote } from "@backstop/mover";
import { createDeposit, GAS_ALLOWANCE_YOCTO } from "@/lib/create-vault";
import type { TopUpDeps } from "@/lib/fund/near-topup";
import { realDeps } from "@/lib/fund/server-deps";
import { viewAccount } from "@/lib/near-rpc";
import { PUBLIC_ENV } from "@/lib/public-env";

export function realTopUpDeps(): TopUpDeps {
  // realDeps() also points the NEAR RPC client at NEAR_RPC_URL + the registry list.
  const fund = realDeps();
  return {
    enabled: PUBLIC_ENV.getNearEnabled,
    tokens: fund.tokens,
    needYocto: () => {
      const deposit = createDeposit(PUBLIC_ENV.policyCodeBytes);
      return deposit === null ? null : deposit + GAS_ALLOWANCE_YOCTO;
    },
    accountExists: async (accountId) => (await viewAccount(accountId)) !== null,
    requestQuote: fund.requestQuote,
    // 1Click's quote-signing key from the registry (ONE_CLICK.managerPublicKey), node:crypto ed25519.
    verifySignature: (canonical, signature) => verifyCanonicalQuote(canonical, signature),
    now: () => Date.now(),
    extraFee: fund.extraFee,
  };
}
