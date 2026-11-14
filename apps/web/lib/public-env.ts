/**
 * Public (browser-visible) configuration. Every value is an identifier, a public key, a hash or a URL,
 * never a secret. `process.env.NEXT_PUBLIC_*` must be written out literally for Next to inline it.
 */
import { isNearAccountId } from "@/lib/validate";

function nearId(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && isNearAccountId(v) ? v : undefined;
}

/** ed25519 public key as NEAR prints it: `ed25519:` + base58 of 32 bytes. */
export const ED25519_PUBLIC_KEY_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

function positiveInt(value: string | undefined): number | undefined {
  const v = value?.trim() ?? "";
  if (!/^[1-9]\d{0,8}$/.test(v)) return undefined;
  return Number(v);
}

export const PUBLIC_ENV = {
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3000",
  /** Optional legacy factory: only used as a source of the published code hash. */
  factoryId: nearId(process.env.NEXT_PUBLIC_FACTORY_ID),
  /** Pre-fills step 3 for the demo. */
  policyId: nearId(process.env.NEXT_PUBLIC_POLICY_CONTRACT_ID),
  /** The Backstop bot: every vault created here names it as agent. Unset = vault creation is off. */
  agentId: nearId(process.env.NEXT_PUBLIC_AGENT_ACCOUNT_ID),
  /** WalletConnect / Reown project id. Unset = WalletConnect is hidden (D19). */
  wcProjectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID?.trim() || undefined,
  /** Published sha256 of the policy wasm (64 hex). */
  policyCodeHash: /^[0-9a-f]{64}$/i.test(process.env.NEXT_PUBLIC_POLICY_CODE_HASH?.trim() ?? "")
    ? process.env.NEXT_PUBLIC_POLICY_CODE_HASH!.trim().toLowerCase()
    : undefined,
  /** Size in bytes of that wasm: sets the refundable deposit a new vault needs. Unset = vault creation is off. */
  policyCodeBytes: positiveInt(process.env.NEXT_PUBLIC_POLICY_CODE_BYTES),
  /**
   * Public half of the bot's shared vault-setup key (one key for every vault). A new vault account is created with this as its only
   * key; the bot deploys the policy and deletes the key in the same transaction. Unset = vault creation is off.
   */
  vaultDeployerPk: ED25519_PUBLIC_KEY_RE.test(process.env.NEXT_PUBLIC_VAULT_DEPLOYER_PK?.trim() ?? "")
    ? process.env.NEXT_PUBLIC_VAULT_DEPLOYER_PK!.trim()
    : undefined,
  /** Optional contact shown to people who are not invited: a mailto: address or an https URL. Display only. */
  inviteContact: /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/i.test(process.env.NEXT_PUBLIC_INVITE_CONTACT?.trim() ?? "")
    ? process.env.NEXT_PUBLIC_INVITE_CONTACT!.trim()
    : undefined,
  /** "Get NEAR": swap USDC or ETH on Base into the user's own NEAR account. Only the exact value "1" turns it on. */
  getNearEnabled: process.env.NEXT_PUBLIC_GET_NEAR_ENABLED?.trim() === "1",
} as const;
