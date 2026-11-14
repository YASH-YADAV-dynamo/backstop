/**
 * Vault creation requests as the web sees them: the POST body, the GET answers (zod-validated before the app
 * acts on them), the fetch helpers, and the pending creation this browser remembers across a wallet redirect.
 * Shared by the client and the API route; no secrets, no keys.
 */
import { isVaultName, SALT_RE, type LimitsJson } from "@backstop/core";
import { z } from "zod";
import { isNearAccountId } from "@/lib/validate";

const uintString = z.string().regex(/^(0|[1-9]\d*)$/);
const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const limitsBodySchema: z.ZodType<LimitsJson> = z
  .object({
    trigger_hf_bps: uint,
    target_hf_bps: uint,
    max_per_rescue: uintString,
    daily_cap: uintString,
    cooldown_secs: uint,
    max_fee_per_gas: uintString,
    max_gas_limit: uintString,
  })
  .strict();

/** POST /api/vaults: exactly the fields the vault name commits to. */
export const createBodySchema = z
  .object({
    vaultId: z.string().refine(isVaultName, "vaultId must look like bkst-<20 hex>.near"),
    owner: z.string().refine(isNearAccountId, "owner must be a NEAR account id"),
    chainKey: z.string().max(32),
    borrower: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "borrower must be a 0x address"),
    limits: limitsBodySchema,
    salt: z.string().regex(SALT_RE, "salt must be 32 lowercase hex characters"),
  })
  .strict();

export type CreateBody = z.infer<typeof createBodySchema>;

export const REQUEST_STATUSES = ["pending", "deploying", "ready", "failed", "aborted"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** What GET /api/vaults shows of a request (no salt; the owner already knows the rest). */
export const requestViewSchema = z.object({
  vaultId: z.string().refine(isVaultName),
  owner: z.string(),
  chainKey: z.string(),
  status: z.enum(REQUEST_STATUSES),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RequestView = z.infer<typeof requestViewSchema>;

export const listResponseSchema = z.object({ requests: z.array(requestViewSchema) });
export const oneResponseSchema = z.object({ request: requestViewSchema.nullable() });

export async function fetchOwnerRequests(owner: string): Promise<RequestView[]> {
  const res = await fetch(`/api/vaults?owner=${encodeURIComponent(owner)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`The vault service answered HTTP ${res.status}. Try again in a moment.`);
  return listResponseSchema.parse(await res.json()).requests;
}

/** The one message for "not on the invite list", shown by the form, the review preflight and the API. */
export const inviteOnlyMessage = (owner: string): string => `Vault creation is invite-only right now. Ask the Backstop team to add ${owner} to the invite list.`;

/** GET /api/vaults?allowed=<account>: whether THAT account may create; never the list. */
export const inviteResponseSchema = z.object({ allowed: z.boolean(), inviteOnly: z.boolean() });
export type InviteStatus = z.infer<typeof inviteResponseSchema>;

/** Asks the server whether `owner` may create a vault. Throws when it cannot tell (callers fail closed). */
export async function fetchInviteStatus(owner: string): Promise<InviteStatus> {
  const res = await fetch(`/api/vaults?allowed=${encodeURIComponent(owner)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`The vault service answered HTTP ${res.status}. Try again in a moment.`);
  return inviteResponseSchema.parse(await res.json());
}

/** The blocking reason for an invite answer (null = may proceed). `undefined` = not answered yet. */
export function inviteBlockReason(owner: string, invite: InviteStatus | "error" | undefined): string | null {
  if (invite === undefined) return "Checking your invite...";
  if (invite === "error") return "Could not check your invite; try again.";
  return invite.inviteOnly && !invite.allowed ? inviteOnlyMessage(owner) : null;
}

/** Registers the created account with the bot. Same body twice is the same request. */
export async function submitRequest(body: CreateBody): Promise<RequestView> {
  const res = await fetch("/api/vaults", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = z.object({ error: z.string() }).safeParse(json);
    throw new Error(message.success ? message.data.error : `The vault service answered HTTP ${res.status}. Try again in a moment.`);
  }
  const parsed = oneResponseSchema.parse(json);
  if (!parsed.request) throw new Error("The vault service did not return your request. Try again in a moment.");
  return parsed.request;
}

/** The steps the create card shows. */
export type CreateStep = "creating-account" | "installing" | "securing" | "ready";

/** pending = the bot has not started; deploying = deploy sent, waiting for activation and admission. */
export const stepOf = (status: RequestStatus): CreateStep | null =>
  status === "pending" ? "installing" : status === "deploying" ? "securing" : status === "ready" ? "ready" : null;

export const CREATE_STEPS: ReadonlyArray<[CreateStep, string]> = [
  ["creating-account", "Creating account"],
  ["installing", "Installing contract"],
  ["securing", "Securing (removing keys)"],
  ["ready", "Ready"],
];

/** Plain words for a request that ended without a vault. */
export function endedText(r: Pick<RequestView, "status" | "lastError">): string | null {
  if (r.status === "aborted") return "Your vault couldn't be set up, so it was deleted and your NEAR was sent back to your wallet.";
  if (r.status === "failed") {
    return /does not exist/.test(r.lastError ?? "")
      ? "Your vault account was not created. If your wallet approved it, your NEAR was returned to your wallet."
      : "Your vault couldn't be set up. If it holds your NEAR, close it from this app to get the NEAR back, or contact support with the vault name.";
  }
  return null;
}

// ---- Pending creation remembered on this device (redirect wallets navigate away mid-flow) ----------------

export const pendingKey = (owner: string) => `backstop.create.${owner}`;

const pendingSchema = createBodySchema.extend({ startedAt: z.number().int().positive() });
export type PendingCreate = z.infer<typeof pendingSchema>;

export function parsePending(raw: string | null): PendingCreate | null {
  if (!raw) return null;
  try {
    const parsed = pendingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
