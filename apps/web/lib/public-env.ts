/**
 * Public (browser-visible) configuration. Every value is an identifier or a URL, never a secret.
 * `process.env.NEXT_PUBLIC_*` must be written out literally for Next to inline it.
 */
import { isNearAccountId } from "@/lib/validate";

function nearId(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && isNearAccountId(v) ? v : undefined;
}

export const PUBLIC_ENV = {
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3000",
  /** Enables "Create policy" (T2.5). */
  factoryId: nearId(process.env.NEXT_PUBLIC_FACTORY_ID),
  /** Pre-fills step 3 for the demo. */
  policyId: nearId(process.env.NEXT_PUBLIC_POLICY_CONTRACT_ID),
  /** Default agent account in the create form. */
  agentId: nearId(process.env.NEXT_PUBLIC_AGENT_ACCOUNT_ID),
  /** WalletConnect / Reown project id. Unset = WalletConnect is hidden (D19). */
  wcProjectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID?.trim() || undefined,
  /** Published sha256 of the policy wasm (64 hex), for policies that did not come from a factory. */
  policyCodeHash: /^[0-9a-f]{64}$/i.test(process.env.NEXT_PUBLIC_POLICY_CODE_HASH?.trim() ?? "")
    ? process.env.NEXT_PUBLIC_POLICY_CODE_HASH!.trim().toLowerCase()
    : undefined,
} as const;
