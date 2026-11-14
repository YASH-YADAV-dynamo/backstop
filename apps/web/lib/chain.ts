/** Resolves a policy's `chain_id` to its registry entry without throwing (the UI must keep working for a policy on a chain we do not run). */
import { LOAN_CHAINS, loanChainById, type LoanChain } from "@backstop/config/registry";

/** Shown before a policy is loaded, and for wallet-connection copy. */
export const DEFAULT_CHAIN: LoanChain = LOAN_CHAINS[0]!;

/** The loan chain for `chainId`, or null when Backstop does not support it. */
export function resolveChain(chainId: number): LoanChain | null {
  try {
    return loanChainById(chainId);
  } catch {
    return null;
  }
}

/** Like `resolveChain` but falls back to the default chain (display only; verification still fails for unsupported ids). */
export const chainOrDefault = (chainId: number | undefined): LoanChain => (chainId === undefined ? DEFAULT_CHAIN : (resolveChain(chainId) ?? DEFAULT_CHAIN));

/** "<name> (chain id <id>)": the network line of every EVM review. */
export const chainLabel = (chain: LoanChain): string => `${chain.name} (chain id ${chain.chainId})`;

/** The explorer host (for example "arbiscan.io"): the visible text of an explorer link. */
export const explorerHost = (chain: LoanChain): string => new URL(chain.explorer).hostname;
