import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/wallet/providers";

export const metadata: Metadata = {
  title: "App",
  description: "Connect your wallets, set limits and fund your Backstop policy. Every action is approved in your own wallet.",
};

export default function AppLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
