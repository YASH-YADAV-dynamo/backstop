/** wagmi config for the EVM wallet connection (decision D14). Imported only from /app client code. */
import { LOAN_CHAINS } from "@backstop/config/registry";
import { createConfig, fallback, http } from "wagmi";
import type { Transport } from "viem";
import { arbitrum, avalanche, base, bsc, gnosis, mainnet, optimism, polygon } from "wagmi/chains";
// Deep imports: the "wagmi/connectors" barrel pulls in every wallet SDK (Base Account, Coinbase, ...) and fails to bundle.
import { injected } from "wagmi/connectors/injected";
import { walletConnect } from "wagmi/connectors/walletConnect";
import { PUBLIC_ENV } from "@/lib/public-env";
import { SITE } from "@/lib/site";

const chains = [base, mainnet, arbitrum, optimism, polygon, bsc, gnosis, avalanche] as const;

// A chain added to LOAN_CHAINS must also be wired here (viem chain + transport), or the wallet could never switch to it.
for (const c of LOAN_CHAINS) {
  if (!chains.some((w) => w.id === c.chainId)) {
    throw new Error(`${c.name} (${c.chainId}) is in LOAN_CHAINS but not in apps/web/lib/wagmi.ts. Add its wagmi chain to \`chains\`; the checklist is docs/site/09-add-a-chain.md.`);
  }
}

/** Transports for every loan chain, built from the registry RPC lists (not one hand-written line per chain). */
const loanTransports: Record<number, Transport> = Object.fromEntries(LOAN_CHAINS.map((c) => [c.chainId, fallback(c.rpcUrls.map((u) => http(u, { timeout: 10_000 })))]));

export const wagmiConfig = createConfig({
  // Base and Arbitrum are where loans live (LOAN_CHAINS). The others exist only so the fund-from-another-chain tab can send a deposit from the connected wallet (E.9).
  chains,
  ssr: true,
  // EIP-6963 discovery is on by default (multiInjectedProviderDiscovery): each wallet that announces
  // itself becomes its own connector with its own name and icon.
  connectors: [
    injected(),
    ...(PUBLIC_ENV.wcProjectId
      ? [
          walletConnect({
            projectId: PUBLIC_ENV.wcProjectId,
            showQrModal: true,
            metadata: { name: SITE.name, description: SITE.description, url: PUBLIC_ENV.siteUrl, icons: [`${PUBLIC_ENV.siteUrl}/icon.svg`] },
          }),
        ]
      : []),
  ],
  // Cast: the loop above guarantees every loan chain is in `chains`, and `loanTransports` has one entry per loan chain.
  transports: {
    ...loanTransports,
    [mainnet.id]: http(),
    [optimism.id]: http(),
    [polygon.id]: http(),
    [bsc.id]: http(),
    [gnosis.id]: http(),
    [avalanche.id]: http(),
  } as Record<(typeof chains)[number]["id"], Transport>,
});
