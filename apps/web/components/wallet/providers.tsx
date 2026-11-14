"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { NearWalletProvider } from "@/components/wallet/near-provider";
import { wagmiConfig } from "@/lib/wagmi";

/** Mounted only by the /app layout: landing and docs never load wagmi or NEAR Connect. */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } } }));
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <NearWalletProvider>{children}</NearWalletProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
