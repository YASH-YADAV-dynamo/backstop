/**
 * POST /api/invite-request: a NEAR account that is not invited yet asks for an invite, with an optional rough
 * Aave volume and a short note. GET ?account= says whether that account already asked. Stores only what the
 * user typed; grants nothing (invites are still VAULT_ALLOWED_OWNERS, set by the operator).
 */
import type { InviteRequest, InviteRequestStore } from "@backstop/db";
import { z } from "zod";
import { isNearAccountId } from "@/lib/validate";

/** The volume brackets offered in the form (lent + borrowed on Aave so far, in USD). */
export const VOLUME_BRACKETS = [
  { value: "none", label: "Just starting" },
  { value: "under-1k", label: "Under $1k" },
  { value: "1k-10k", label: "$1k - $10k" },
  { value: "10k-100k", label: "$10k - $100k" },
  { value: "over-100k", label: "Over $100k" },
] as const;
export type VolumeBracket = (typeof VOLUME_BRACKETS)[number]["value"];

export const inviteRequestBodySchema = z.object({
  account: z.string().trim().toLowerCase().refine(isNearAccountId, "That is not a NEAR account id."),
  volume: z.enum(VOLUME_BRACKETS.map((b) => b.value) as [VolumeBracket, ...VolumeBracket[]]).nullable().default(null),
  note: z
    .string()
    .trim()
    .max(500, "Keep the note under 500 characters.")
    .nullable()
    .default(null)
    .transform((n) => (n === "" ? null : n)),
});
export type InviteRequestBody = z.input<typeof inviteRequestBodySchema>;

export type InviteApiDeps = { store: () => Promise<InviteRequestStore>; now: () => Date };
export type ApiResult = { status: number; body: unknown };

const view = (r: InviteRequest) => ({ account: r.account, volume: r.volume, requestedAt: r.updatedAt });

export async function handleInviteRequest(body: unknown, deps: InviteApiDeps): Promise<ApiResult> {
  const parsed = inviteRequestBodySchema.safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Bad request." } };
  const row = await (await deps.store()).upsert(parsed.data, deps.now());
  return { status: 200, body: { request: view(row) } };
}

export async function handleInviteStatus(params: URLSearchParams, deps: InviteApiDeps): Promise<ApiResult> {
  const account = params.get("account")?.trim().toLowerCase() ?? "";
  if (!isNearAccountId(account)) return { status: 400, body: { error: "Pass ?account=<NEAR account id>." } };
  const row = await (await deps.store()).get(account);
  return { status: 200, body: { request: row ? view(row) : null } };
}

/** Browser side. */
export const inviteRequestViewSchema = z.object({ account: z.string(), volume: z.string().nullable(), requestedAt: z.string() });
export type InviteRequestView = z.infer<typeof inviteRequestViewSchema>;
const responseSchema = z.object({ request: inviteRequestViewSchema.nullable() });

async function call(input: string, init?: RequestInit): Promise<InviteRequestView | null> {
  const res = await fetch(input, { ...init, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = z.object({ error: z.string() }).safeParse(json);
    throw new Error(err.success ? err.data.error : `The invite request failed (HTTP ${res.status}). Try again.`);
  }
  return responseSchema.parse(json).request;
}

export const fetchInviteRequest = (account: string) => call(`/api/invite-request?account=${encodeURIComponent(account)}`);
export const sendInviteRequest = (body: InviteRequestBody) =>
  call("/api/invite-request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
