import type { Metadata } from "next";
import { ChainBadge } from "@/components/chain-badge";
import { DashboardView } from "@/components/dashboard-view";
import { VaultPrompt } from "@/components/vault-prompt";
import { getDashboard } from "@/lib/data";
import { BAD_VAULT_INPUT, parsePolicyParam } from "@/lib/policy-param";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Live loan health, limits from the Rescue vault, and rescue history.",
};

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ policy?: string | string[] }> }) {
  const raw = (await searchParams).policy;
  const policy = parsePolicyParam(Array.isArray(raw) ? raw[0] : raw);
  if (policy === null) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10">
        <VaultPrompt tone="danger" heading="Pick a vault to watch" body={BAD_VAULT_INPUT} />
      </div>
    );
  }
  const snapshot = await getDashboard(policy);
  const chain = snapshot.policy.state === "ok" ? snapshot.policy.data.chain : null;
  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-4xl">Dashboard</h1>
        {chain ? <ChainBadge chain={chain} className="text-sm" /> : null}
      </div>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">Live from mainnet: the vault on NEAR and its Aave loan on {chain ? chain.name : "its loan chain"}.</p>
      <DashboardView initial={snapshot} policy={policy} />
    </div>
  );
}
