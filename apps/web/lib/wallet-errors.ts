/** Classify errors thrown by wallets (NEAR Connect adapters and EIP-1193 providers). */
import { z } from "zod";
import { findFailure } from "@/lib/near-rpc";

type Link = { name: string; message: string; code?: unknown };

function chain(err: unknown): Link[] {
  const out: Link[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (typeof cur === "string") {
      out.push({ name: "", message: cur });
      break;
    }
    if (typeof cur !== "object") break;
    try {
      const o = cur as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown; shortMessage?: unknown; details?: unknown };
      const message = typeof o.shortMessage === "string" ? o.shortMessage : typeof o.message === "string" ? o.message : "";
      out.push({ name: typeof o.name === "string" ? o.name : "", message, code: o.code });
      // viem keeps the wallet's own words in `details`: classify on them too.
      if (typeof o.details === "string" && o.details !== message) out.push({ name: "", message: o.details, code: undefined });
      cur = o.cause;
    } catch {
      // A getter that throws (some wallet proxies): stop walking, keep what we have.
      break;
    }
  }
  return out;
}

const REJECT_TEXT = /user (rejected|denied|declined|cancel|closed)|rejected the request|request (was )?rejected|denied transaction|cancell?ed|closed the (window|popup)|action_rejected/i;

/**
 * A wallet request that is already open, so the wallet refused a new one. Seen as code -32002 (MetaMask,
 * Rabby), "already pending" (WalletConnect) and "Connection declined ... a previous request is still
 * active" (Rabby through NEAR Connect's Ethereum Wallets). Checked before rejection: it is not a "no".
 */
const PENDING_TEXT =
  /already pending|already processing|already (has|have) a (pending|open) request|previous request (is )?(still )?(active|pending|open|in progress)|request (is )?already (active|open|in progress)|connection declined/i;

/** A wallet request that is already open (-32002, "already pending"): the user must act in the wallet. */
export function isRequestPending(err: unknown): boolean {
  return chain(err).some((e) => e.code === -32002 || PENDING_TEXT.test(e.message));
}

/** The user said no (or closed the wallet). Not an error state (row 6). A request blocked by an open one is NOT a rejection. */
export function isUserRejection(err: unknown): boolean {
  if (isRequestPending(err)) return false;
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

export function errorText(err: unknown): string {
  const parts = chain(err).map((e) => e.message).filter(Boolean);
  const first = parts[0] ?? (err instanceof Error ? err.message : "");
  return (first || "Unknown error").split("\n")[0]!.slice(0, 300);
}

export type WalletErrorKind = "pending" | "rejected" | "popup-blocked" | "unknown-chain" | "other";

/** One kind per error, in priority order: an open request first (it often looks like a refusal), then a "no". */
export function classifyWalletError(err: unknown): WalletErrorKind {
  if (isRequestPending(err)) return "pending";
  if (isUserRejection(err)) return "rejected";
  if (isPopupBlocked(err)) return "popup-blocked";
  if (isUnknownChain(err)) return "unknown-chain";
  return "other";
}

export const WALLET_MESSAGES = {
  pending: "Your wallet still has an earlier request open. Open your wallet, finish or reject that request, then press Try again.",
  popupBlocked: "Your browser blocked the wallet popup. Allow popups for this site, or open this page in your wallet's browser, then press Try again.",
} as const;

/**
 * Plain words for a failed wallet request. `action` reads like "Could not connect"; `retry` names the button
 * that tries again (default "Try again"), so every message ends with what to do next.
 */
export function walletErrorMessage(err: unknown, action: string, retry = "Try again"): { kind: WalletErrorKind; message: string } {
  const kind = classifyWalletError(err);
  switch (kind) {
    case "pending":
      return { kind, message: `Your wallet still has an earlier request open. Open your wallet, finish or reject that request, then press ${retry}.` };
    case "rejected":
      return { kind, message: `Cancelled in wallet. Press ${retry} when ready.` };
    case "popup-blocked":
      return { kind, message: `Your browser blocked the wallet popup. Allow popups for this site, or open this page in your wallet's browser, then press ${retry}.` };
    case "unknown-chain":
      return { kind, message: `Your wallet does not know this network yet. Add the network in your wallet, then press ${retry}.` };
    default:
      return { kind, message: `${action}: ${errorText(err)}. Press ${retry}; if it keeps failing, reload the page or pick another wallet.` };
  }
}

export type ParsedOutcome = { hash: string | null; failure: string | null };

const NONE: ParsedOutcome = { hash: null, failure: null };
/** A NEAR transaction hash: base58 of 32 bytes. Anything else is not linked or polled. */
const NEAR_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,50}$/;

const nearHash = z.string().regex(NEAR_HASH).optional().catch(undefined);
/** Each field is read on its own: one malformed field never hides the others (`.catch` drops just that field). */
const outcomeSchema = z.object({
  status: z.unknown().optional(),
  transaction: z.object({ hash: nearHash }).passthrough().optional().catch(undefined),
  transaction_outcome: z.object({ id: nearHash }).passthrough().optional().catch(undefined),
  transactionHash: nearHash,
  hash: nearHash,
  receipts_outcome: z.array(z.unknown()).optional().catch(undefined),
});
const receiptSchema = z.object({ outcome: z.object({ status: z.unknown().optional() }).passthrough() }).passthrough();

function failureOf(status: unknown, receipts: unknown[]): string | null {
  const readable = receipts.flatMap((r) => {
    const p = receiptSchema.safeParse(r);
    return p.success ? [{ outcome: { status: p.data.outcome.status } }] : [];
  });
  try {
    return findFailure({ status, receipts_outcome: readable });
  } catch {
    // A failure we cannot turn into text (circular or BigInt inside): still a failure.
    return "The transaction failed and the wallet's report could not be read.";
  }
}

/**
 * What a NEAR wallet returned from signAndSendTransaction. Never throws. Wallets may return nothing (redirect
 * wallets), a bare hash string, or a partial outcome; whatever cannot be read becomes null, so the caller
 * reports "unknown" and keeps the journal.
 */
export function parseOutcome(raw: unknown): ParsedOutcome {
  try {
    if (typeof raw === "string") return { hash: NEAR_HASH.test(raw) ? raw : null, failure: null };
    const parsed = outcomeSchema.safeParse(raw);
    if (!parsed.success) return NONE;
    const o = parsed.data;
    const hash = o.transaction?.hash ?? o.transaction_outcome?.id ?? o.transactionHash ?? o.hash ?? null;
    return { hash, failure: failureOf(o.status, o.receipts_outcome ?? []) };
  } catch {
    return NONE;
  }
}
