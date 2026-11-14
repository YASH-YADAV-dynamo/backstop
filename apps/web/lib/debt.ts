/** Which kind of Aave debt a borrower has on a loan chain. Pure: the reads live in loan-client. */
export type DebtKind = "usdc" | "none" | "other";

/**
 * Backstop repays native-USDC variable debt only (USDC.e on Arbitrum, stable debt and other assets are not repayable by a rescue).
 * `usdcVariableDebt` is the balance of the chain's native-USDC variable debt token; `totalDebtBase` is Aave's total debt in USD.
 */
export function classifyDebt(input: { usdcVariableDebt: bigint; totalDebtBase: bigint }): DebtKind {
  if (input.usdcVariableDebt > 0n) return "usdc";
  return input.totalDebtBase > 0n ? "other" : "none";
}

/** The calm sentence shown when a vault must not be created for this loan, or null when it can be. */
export function debtBlockReason(kind: DebtKind, chainName: string): string | null {
  if (kind === "usdc") return null;
  if (kind === "none") return `We found no Aave loan at this address on ${chainName}.`;
  return "This loan's debt isn't USDC. Backstop can only repay USDC debt for now.";
}
