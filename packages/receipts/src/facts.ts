/**
 * The numbers a receipt may mention, derived from a RescueRecord. Both the AI prompt and the
 * template use these, so the two receipts can never disagree on a number.
 */
import { formatUsdc, type RescueRecord } from "@backstop/core";

export interface ReceiptFacts {
  status: RescueRecord["status"];
  amountUsdc: string;
  hfBefore: string;
  hfAfter?: string;
  /** Whole seconds from trigger to repay mined. */
  durationSecs?: number;
  error?: string;
}

const fmtHf = (hf: number): string => (Number.isFinite(hf) ? hf.toFixed(2) : "no debt");

function amountOf(raw: string): string {
  return /^\d+$/.test(raw) ? formatUsdc(BigInt(raw)) : raw;
}

/** First line of the error, without a trailing period, so it fits inside one sentence. */
function shortError(error: string): string {
  return (error.split(/\r?\n/)[0] ?? "").trim().replace(/[.!?]+$/, "").slice(0, 160);
}

export function factsOf(r: RescueRecord): ReceiptFacts {
  const facts: ReceiptFacts = { status: r.status, amountUsdc: amountOf(r.amount), hfBefore: fmtHf(r.hfBefore) };
  if (r.hfAfter !== undefined) facts.hfAfter = fmtHf(r.hfAfter);
  if (r.repayMinedAt) {
    const ms = Date.parse(r.repayMinedAt) - Date.parse(r.triggeredAt);
    if (Number.isFinite(ms) && ms >= 0) facts.durationSecs = Math.round(ms / 1000);
  }
  if (r.error) facts.error = shortError(r.error);
  return facts;
}

/** Facts as "key: value" lines for the prompt. */
export function factsText(f: ReceiptFacts): string {
  const lines = [
    `status: ${f.status === "dry-run" ? "dry run (no funds moved, no transactions sent)" : f.status}`,
    `amount: ${f.amountUsdc} USDC`,
    `health factor before: ${f.hfBefore}`,
  ];
  if (f.hfAfter !== undefined) lines.push(`health factor after: ${f.hfAfter}`);
  if (f.durationSecs !== undefined) lines.push(`seconds from trigger to repayment: ${f.durationSecs}`);
  if (f.error !== undefined) lines.push(`error: ${f.error}`);
  return lines.join("\n");
}

/** Deterministic 3-sentence receipt. */
export function templateReceipt(f: ReceiptFacts): string {
  const loan = "your Aave loan on Base";
  switch (f.status) {
    case "dry-run":
      return (
        `Backstop ran a dry run because the health factor of ${loan} was ${f.hfBefore}. ` +
        `It would have repaid ${f.amountUsdc} USDC to lift the health factor. ` +
        "No funds were moved and no transactions were sent."
      );
    case "success":
      return (
        `Backstop repaid ${f.amountUsdc} USDC of ${loan} when its health factor was ${f.hfBefore}. ` +
        (f.hfAfter !== undefined ? `After the repayment the health factor is ${f.hfAfter}. ` : "The new health factor was not read back. ") +
        (f.durationSecs !== undefined
          ? `The rescue finished ${f.durationSecs} seconds after it was triggered.`
          : "The transaction links in this record show each step.")
      );
    case "failed":
      return (
        `Backstop tried to repay ${f.amountUsdc} USDC of ${loan} when its health factor was ${f.hfBefore}. ` +
        `The rescue did not complete${f.error ? `: ${f.error}` : ""}. ` +
        "The transaction links in this record show how far it got."
      );
  }
}
