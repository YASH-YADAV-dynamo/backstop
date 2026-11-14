/**
 * Server-side reader of the bot's `vault_status` row. The store reader is provided by `@backstop/db` (coder B); until it lands
 * this adapter answers "no row", which the app shows as "Not watched" (never "Protected"). In development only,
 * BACKSTOP_VAULT_STATUS_FIXTURE=watching|stale|rescuing|low-gas|refused returns a typed fixture so every pill can be seen.
 * Whatever comes back is validated with zod before the app acts on it.
 */
import { vaultStatusSchema, type VaultStatus } from "@/lib/vault-status";

const fixtureKinds = ["watching", "stale", "rescuing", "low-gas", "refused"] as const;
type FixtureKind = (typeof fixtureKinds)[number];

export function fixtureRow(kind: FixtureKind, policyId: string, now: number): unknown {
  const base = {
    policyId,
    chainId: 8453,
    checkedAt: now - 20_000,
    state: "watching",
    hf: String(1_620_000_000_000_000_000n),
    readiness: { funds: "ok", gas: "ok", debt: "usdc" },
  };
  switch (kind) {
    case "watching":
      return base;
    case "stale":
      return { ...base, checkedAt: now - 600_000 };
    case "rescuing":
      return { ...base, state: "rescuing", hf: String(1_080_000_000_000_000_000n) };
    case "low-gas":
      return { ...base, readiness: { funds: "ok", gas: "low", debt: "usdc" } };
    case "refused":
      return { ...base, state: "refused", reason: "ERR_KEYS_PRESENT" };
  }
}

/** The raw row for a vault, or null when the bot has never written one. */
async function readRow(policyId: string, now: number): Promise<unknown | null> {
  const fixture = process.env.NODE_ENV === "production" ? undefined : process.env.BACKSTOP_VAULT_STATUS_FIXTURE;
  if (fixture && (fixtureKinds as readonly string[]).includes(fixture)) return fixtureRow(fixture as FixtureKind, policyId, now);
  return null;
}

/** Validates a raw row. A row we cannot understand, or one for another vault, is the same as no row: never guess "watched". */
export function parseRow(raw: unknown, policyId: string, now: number): { status: VaultStatus | null; ageMs: number | null } {
  const parsed = vaultStatusSchema.safeParse(raw);
  if (!parsed.success || parsed.data.policyId !== policyId) return { status: null, ageMs: null };
  return { status: parsed.data, ageMs: now - parsed.data.checkedAt };
}

export async function readVaultStatus(policyId: string, now = Date.now()): Promise<{ status: VaultStatus | null; ageMs: number | null }> {
  const raw = await readRow(policyId, now);
  return raw === null ? { status: null, ageMs: null } : parseRow(raw, policyId, now);
}
