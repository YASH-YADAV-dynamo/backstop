/** Classify errors thrown by wallets (NEAR Connect adapters and EIP-1193 providers). */
import { z } from "zod";
import { findFailure } from "@/lib/near-rpc";

function chain(err: unknown): Array<{ name: string; message: string; code?: unknown }> {
  const out: Array<{ name: string; message: string; code?: unknown }> = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (typeof cur === "string") {
      out.push({ name: "", message: cur });
      break;
    }
    if (typeof cur !== "object") break;
    const o = cur as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown; shortMessage?: unknown };
    out.push({
      name: typeof o.name === "string" ? o.name : "",
      message: typeof o.shortMessage === "string" ? o.shortMessage : typeof o.message === "string" ? o.message : "",
      code: o.code,
    });
    cur = o.cause;
  }
  return out;
}

const REJECT_TEXT = /user (rejected|denied|declined|cancel|closed)|rejected the request|request (was )?rejected|denied transaction|cancell?ed|closed the (window|popup)|action_rejected/i;

/** The user said no (or closed the wallet). Not an error state (row 6). */
export function isUserRejection(err: unknown): boolean {
  return chain(err).some((e) => e.code === 4001 || e.code === "ACTION_REJECTED" || e.name === "UserRejectedRequestError" || REJECT_TEXT.test(e.message));
}

/** Wallet popup blocked by the browser (row 24). */
export function isPopupBlocked(err: unknown): boolean {
  return chain(err).some((e) => /popup.*(block|prevent)|block.*popup|window\.open/i.test(e.message));
}

/** EIP-1193 4902: the wallet does not know the chain. */
export function isUnknownChain(err: unknown): boolean {
  return chain(err).some((e) => e.code === 4902 || /unrecogni[sz]ed chain|chain.*not (been )?added/i.test(e.message));
}

/** A wallet request that is already open (-32002, "already pending"): the user must act in the wallet. */
export function isRequestPending(err: unknown): boolean {
  return chain(err).some((e) => e.code === -32002 || /already pending|already processing/i.test(e.message));
}

export function errorText(err: unknown): string {
  const parts = chain(err).map((e) => e.message).filter(Boolean);
  return (parts[0] ?? (err instanceof Error ? err.message : "Unknown error")).split("\n")[0]!.slice(0, 300);
}

const outcomeSchema = z
  .object({
    status: z.unknown().optional(),
    transaction: z.object({ hash: z.string() }).passthrough().optional(),
    transaction_outcome: z.object({ id: z.string() }).passthrough().optional(),
    receipts_outcome: z.array(z.object({ outcome: z.object({ status: z.unknown().optional() }).passthrough() }).passthrough()).optional(),
  })
  .passthrough();

export type ParsedOutcome = { hash: string | null; failure: string | null };

/** What a NEAR wallet returned from signAndSendTransaction. Wallets may return nothing (redirect wallets). */
export function parseOutcome(raw: unknown): ParsedOutcome {
  const parsed = outcomeSchema.safeParse(raw);
  if (!parsed.success) return { hash: null, failure: null };
  const o = parsed.data;
  return { hash: o.transaction?.hash ?? o.transaction_outcome?.id ?? null, failure: findFailure(o) };
}
