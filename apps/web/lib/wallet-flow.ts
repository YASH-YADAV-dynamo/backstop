/**
 * Pure wallet-flow logic, kept out of React so it can be unit tested: the one-request-at-a-time guard,
 * how a NEAR wallet's answer maps to a result (and what happens to the pending journal), which EVM wallets
 * are offered, and the extra hint for NEAR accounts that come from an Ethereum wallet.
 */
import { nearText } from "@/lib/create-vault";
import { explainContractError } from "@/lib/policy-client";
import { PUBLIC_ENV } from "@/lib/public-env";
import { classifyWalletError, errorText, parseOutcome, WALLET_MESSAGES } from "@/lib/wallet-errors";

/** After this long without an answer, the UI offers "Still waiting for your wallet" with a way out. */
export const WALLET_STALL_MS = 30_000;

export type InFlightGuard = {
  /** Takes the single slot: a token, or null when a request is already open (the second click does nothing). */
  begin: () => number | null;
  /** Frees the slot if `token` still holds it. False when the guard was reset meanwhile: that answer is late. */
  end: (token: number) => boolean;
  /** Whether `token` still holds the slot. */
  holds: (token: number) => boolean;
  /** Frees the slot whoever holds it (the user pressed Reset). Late answers to the old request are then ignored. */
  reset: () => void;
  busy: () => boolean;
};

export function createInFlightGuard(): InFlightGuard {
  let current: number | null = null;
  let next = 1;
  return {
    begin: () => {
      if (current !== null) return null;
      current = next++;
      return current;
    },
    end: (token) => {
      if (current !== token) return false;
      current = null;
      return true;
    },
    holds: (token) => current === token,
    reset: () => {
      current = null;
    },
    busy: () => current !== null,
  };
}

export type NearSendResult =
  | { status: "success"; hashes: string[] }
  | { status: "rejected" }
  /** The contract (or token) refused. `details` is the raw text. */
  | { status: "failed"; message: string; details: string; hashes: string[] }
  /** The wallet did not give us a final result: it may or may not have been sent. The journal keeps the action. */
  | { status: "unknown"; message: string }
  /** The wallet (or this page) already has a request open; nothing new was sent. The user finishes it, then tries again. */
  | { status: "pending"; message: string };

/** A NEAR result plus what to do with the pending journal: keep it (maybe sent) or clear it (known final). */
export type NearAnswer = { result: NearSendResult; hash: string | null; clearJournal: boolean };

export const SEND_ALREADY_OPEN = "Your wallet is already showing a request from this page. Approve or reject it there, then press Try again.";

/** What the wallet's resolved answer means. `txCount`: how many transactions were asked for. Never throws. */
export function interpretNearOutcomes(outcomes: unknown, txCount: number): NearAnswer {
  const parsed = (Array.isArray(outcomes) ? outcomes : [outcomes]).map(parseOutcome);
  const hashes = parsed.flatMap((p) => (p.hash ? [p.hash] : []));
  const hash = hashes[0] ?? null;
  const failure = parsed.find((p) => p.failure)?.failure;
  if (failure) {
    const { message } = explainContractError(failure);
    return { result: { status: "failed", message, details: failure, hashes }, hash, clearJournal: true };
  }
  if (hashes.length === 0) {
    return {
      result: { status: "unknown", message: "Your wallet did not report a result. If it asked you to approve, the transaction may be on its way; we will check the chain." },
      hash,
      clearJournal: false,
    };
  }
  if (hashes.length < txCount) {
    return {
      result: { status: "unknown", message: `Your wallet reported ${hashes.length} of ${txCount} transactions. Check your wallet's history before trying again.` },
      hash,
      clearJournal: false,
    };
  }
  return { result: { status: "success", hashes }, hash, clearJournal: true };
}

/** What the wallet's error means. Only answers that prove nothing was sent clear the journal. */
export function interpretNearError(err: unknown): NearAnswer {
  const kind = classifyWalletError(err);
  if (kind === "pending") return { result: { status: "pending", message: WALLET_MESSAGES.pending }, hash: null, clearJournal: true };
  if (kind === "rejected") return { result: { status: "rejected" }, hash: null, clearJournal: true };
  if (kind === "popup-blocked") {
    return { result: { status: "failed", message: WALLET_MESSAGES.popupBlocked, details: errorText(err), hashes: [] }, hash: null, clearJournal: true };
  }
  // Anything else may have happened after the wallet submitted (flaky network): keep the journal (row 14).
  return {
    result: { status: "unknown", message: `Your wallet reported a problem (${errorText(err)}). It may still have been sent; check your wallet's history before trying again.` },
    hash: null,
    clearJournal: false,
  };
}

type ConnectorLike = { id: string; type: string };

/**
 * EVM wallets offered in the picker (row 9). Wallets that announced themselves (EIP-6963) are listed by name;
 * the bare `window.ethereum` entry is only offered when none did, because with several extensions installed it
 * belongs to whichever one won the race, not to the wallet the user picked.
 */
export function evmWalletChoices<C extends ConnectorLike>(connectors: readonly C[], hasBareProvider: boolean): C[] {
  const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  const generic = connectors.filter((c) => c.id === "injected");
  const others = connectors.filter((c) => c.type !== "injected");
  return [...announced, ...(announced.length === 0 && hasBareProvider ? generic : []), ...others];
}

/**
 * Shown when a transaction is for one network and the wallet is on another. `have` is the wallet's network by name
 * (null when it is not known); raw chain ids never reach the user.
 */
export function wrongNetworkMessage(have: string | null, want: string): string {
  return `Your wallet is on ${have ?? "another network"}; this transaction is on ${want}. Switch to ${want}, then start again: this window closes when the network changes.`;
}

/** After this many failed tries in a row, the create card stops retrying on its own and offers "Try again". */
export const PENDING_MAX_FAILURES = 10;
export const pendingGivesUp = (failuresInARow: number): boolean => failuresInARow >= PENDING_MAX_FAILURES;

const EVM_ACCOUNT = /^0x[0-9a-f]{40}$/i;

/** A NEAR account created from an Ethereum wallet (NEAR Connect's "Ethereum Wallets"). */
export function isEthereumNearAccount(walletName: string, accountId: string): boolean {
  return /ethereum/i.test(walletName) || EVM_ACCOUNT.test(accountId);
}

/**
 * Extra words for an Ethereum-wallet NEAR account that is short of NEAR: ETH or USDC in that wallet cannot pay
 * NEAR fees or deposits. Null when the account is not such an account, or has enough.
 */
export function ethereumWalletNearHint(
  input: { walletName: string; accountId: string; needYocto: bigint; haveYocto: bigint | null },
  /** Swapping into NEAR is on (NEXT_PUBLIC_GET_NEAR_ENABLED=1): point to the deposit step's "MetaMask / Rabby" tab instead of an exchange. */
  getNear: boolean = PUBLIC_ENV.getNearEnabled,
): string | null {
  if (!isEthereumNearAccount(input.walletName, input.accountId)) return null;
  if (input.haveYocto === null || input.haveYocto >= input.needYocto) return null;
  const missing = input.needYocto - input.haveYocto;
  if (getNear) {
    return `Your NEAR account comes from an Ethereum wallet. This step needs about ${nearText(input.needYocto, 3)} in NEAR itself; ETH or USDC cannot pay it directly. Use the "MetaMask / Rabby" tab in the deposit step to swap USDC or ETH on Base into at least ${nearText(missing, 3)} for ${input.accountId}, or send that much NEAR from an exchange, then try again.`;
  }
  return `Your NEAR account comes from an Ethereum wallet. This step needs about ${nearText(input.needYocto, 3)} in NEAR itself; ETH or USDC in that wallet cannot pay it. Send at least ${nearText(missing, 3)} to ${input.accountId} (for example from an exchange), then try again.`;
}
