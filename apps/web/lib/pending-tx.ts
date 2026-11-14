/**
 * Pending-transaction journal (E.6). One entry at a time. Written BEFORE the wallet is called,
 * updated with the hash once known, deleted on a final result. Contains no secrets.
 * sessionStorage is the primary store; it is mirrored to localStorage keyed by account so a closed
 * tab can resume. Every storage access is wrapped: private windows and blocked storage must not break the app.
 */
import type { LoanChain } from "@backstop/config/registry";
import { z } from "zod";
import { resolveChain } from "@/lib/chain";

export const JOURNAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const entrySchema = z.object({
  id: z.string(),
  kind: z.string(),
  chain: z.enum(["near", "evm"]),
  account: z.string(),
  contractId: z.string(),
  method: z.string(),
  args: z.unknown(),
  createdAt: z.number(),
  hash: z.string().optional(),
  /** EVM entries: the chain the transaction was sent on. Entries written before multi-chain support have none. */
  evmChainId: z.number().optional(),
});

export type JournalEntry = z.infer<typeof entrySchema>;
export type NewJournalEntry = Omit<JournalEntry, "id" | "createdAt" | "hash">;

/**
 * The loan chain whose receipt may be polled for `entry`, or null. A hash is only ever looked up on the chain it was
 * sent on: an old entry (no chain id) or one sent on an origin chain we do not run is never polled on a guessed chain.
 */
export function receiptChainFor(entry: JournalEntry): LoanChain | null {
  return entry.chain === "evm" && entry.evmChainId !== undefined ? resolveChain(entry.evmChainId) : null;
}

const SESSION_KEY = "backstop:pending";
const localKey = (account: string) => `backstop:pending:${account}`;

function read(store: Storage | undefined, key: string): JournalEntry | null {
  try {
    const raw = store?.getItem(key);
    if (!raw) return null;
    const parsed = entrySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function stores(): { session?: Storage; local?: Storage } {
  try {
    return { session: window.sessionStorage, local: window.localStorage };
  } catch {
    return {};
  }
}

function write(entry: JournalEntry): void {
  const { session, local } = stores();
  try {
    const json = JSON.stringify(entry);
    session?.setItem(SESSION_KEY, json);
    local?.setItem(localKey(entry.account), json);
  } catch {
    /* storage unavailable: the in-memory flow still works, only resume-after-close is lost */
  }
}

export type LoadedJournal = { entry: JournalEntry | null; expired: boolean };

/** The unresolved entry for `account`, if any. Entries older than 24 h are dropped and reported. */
export function loadJournal(account: string): LoadedJournal {
  const { session, local } = stores();
  const fromSession = read(session, SESSION_KEY);
  const entry = fromSession?.account === account ? fromSession : read(local, localKey(account));
  if (!entry) return { entry: null, expired: false };
  if (Date.now() - entry.createdAt > JOURNAL_MAX_AGE_MS) {
    clearJournal(account);
    return { entry: null, expired: true };
  }
  return { entry, expired: false };
}

/** Refuses a second entry while one is unresolved (row 22). */
export function startJournal(input: NewJournalEntry): JournalEntry {
  const existing = loadJournal(input.account).entry;
  if (existing) {
    throw new Error(`An earlier ${existing.method} is still waiting for confirmation. Wait for it to finish, or cancel it first.`);
  }
  const entry: JournalEntry = { ...input, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now() };
  write(entry);
  return entry;
}

export function setJournalHash(entry: JournalEntry, hash: string): JournalEntry {
  const next = { ...entry, hash };
  write(next);
  return next;
}

export function clearJournal(account: string): void {
  const { session, local } = stores();
  try {
    if (read(session, SESSION_KEY)?.account === account) session?.removeItem(SESSION_KEY);
    local?.removeItem(localKey(account));
  } catch {
    /* ignore */
  }
}

/**
 * Redirect-wallet return (row 16): NEAR wallets that navigate away come back with
 * `?transactionHashes=` (success) or `?errorCode=&errorMessage=` (failure). Read once, then strip.
 */
export type RedirectResult = { hashes: string[] } | { error: string } | null;

export function consumeRedirectParams(): RedirectResult {
  try {
    const url = new URL(window.location.href);
    const hashes = url.searchParams.get("transactionHashes");
    const errorCode = url.searchParams.get("errorCode");
    const errorMessage = url.searchParams.get("errorMessage");
    if (!hashes && !errorCode && !errorMessage) return null;
    for (const k of ["transactionHashes", "errorCode", "errorMessage", "signMeta", "account_id", "public_key", "all_keys"]) url.searchParams.delete(k);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    if (hashes) return { hashes: hashes.split(",").filter((h) => /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(h)) };
    return { error: decodeURIComponent(errorMessage ?? errorCode ?? "The wallet reported an error.").slice(0, 300) };
  } catch {
    return null;
  }
}
