/** Pure state machine of /app (D31, J.2): which screen to show and what to ask the user to do next. No network, no React. */

import { isFresh, statusHf, type VaultStatus } from "@/lib/vault-status";

export type AppStage = "connect" | "protect" | "fund" | "home";

export type StageInput = {
  /** Connected NEAR account, or null. */
  owner: string | null;
  /** The selected vault, or null when the account has none. */
  policyId: string | null;
  /** The vault could not be read and there is no earlier snapshot to show. */
  readError: boolean;
  /** The vault snapshot (and its checks) is loaded. */
  loaded: boolean;
  /** The connected account is the vault's owner. */
  owned: boolean;
  /** No failed safety check. */
  verified: boolean;
  /** The rescue wallet exists. */
  activated: boolean;
  usdcBalance: bigint;
  rescueCount: number;
};

/**
 * connect: no NEAR account. protect: no vault, unreadable, still loading, or an owned vault that is not yet
 * safe and set up. fund: ready but empty and never used. home: everything else, including someone else's
 * vault (view-only: the shell shows it without actions).
 */
export function appStage(input: StageInput): AppStage {
  if (input.owner === null) return "connect";
  if (input.policyId === null || input.readError || !input.loaded) return "protect";
  if (!input.owned) return "home";
  if (!input.verified || !input.activated) return "protect";
  return input.usdcBalance === 0n && input.rescueCount === 0 ? "fund" : "home";
}

/** What the journal's `kind` is called in the pending banner; an unknown kind falls back to the contract method. */
export const KIND_LABEL: Record<string, string> = {
  deposit: "Add USDC",
  withdraw: "Withdraw USDC",
  withdraw_near: "Withdraw NEAR",
  set_limits: "New limits",
  pause: "Pause",
  unpause: "Resume",
  set_agent: "Change rescue bot",
  set_borrower: "Change loan address",
  close: "Close vault",
  activate: "Set up rescue wallet",
  gas_topup: "Gas money",
  fund_from_chain: "Deposit from another chain",
  create_policy: "Create vault",
  claim_refund: "Claim refund",
};

export const kindLabel = (kind: string, method: string): string => KIND_LABEL[kind] ?? method;

// ---- Status pill (v3 section 2.2) -----------------------------------------------------------------------------------

export type PillId = "paused" | "rescuing" | "not-watched" | "needs-usdc" | "needs-gas" | "nothing" | "at-risk" | "protected";
export type PillTone = "grey" | "orange" | "red" | "amber" | "green";
export type PillAction = "resume" | "retry" | "usdc" | "gas" | "aave" | "none";

export type PillInput = {
  paused: boolean;
  /** The bot's latest row for this vault, or null when there is none (or it could not be read). */
  status: VaultStatus | null;
  /** How old that row is by the server's clock; null when there is no row. */
  statusAgeMs: number | null;
  /** Our own read of the vault's USDC is exactly zero. */
  usdcEmpty: boolean;
  /** Our own read of the rescue wallet's ETH is exactly zero. */
  gasEmpty: boolean;
  /** Our own live read of health (a number, null = no debt), or undefined when the loan chain did not answer. */
  hf: number | null | undefined;
  /** Display strings for the copy. */
  text: { trigger: string; chain: string; usdc: string; maxPerRescue: string };
};

export type Pill = { id: PillId; label: string; tone: PillTone; line: string; action: PillAction };

/**
 * First match wins. "Protected" needs a bot row that is under two minutes old, in state "watching", with funds, gas and
 * debt all ok: without that proof the answer is "Not watched". Thresholds for "low" are the bot's, never ours; our only own
 * rule is an exact zero.
 */
export function statusPill(i: PillInput): Pill {
  const { trigger, chain, usdc, maxPerRescue } = i.text;
  if (i.paused) return { id: "paused", label: "Paused", tone: "grey", line: "Rescues are paused. Your loan is not protected.", action: "resume" };
  const row = i.status;
  if (row?.state === "rescuing" && isFresh(i.statusAgeMs)) {
    return { id: "rescuing", label: "Rescue in progress", tone: "orange", line: "Repaying part of your loan now. This takes a minute or two.", action: "none" };
  }
  const watching = row !== null && row.state === "watching" && isFresh(i.statusAgeMs);
  if (!watching) {
    return {
      id: "not-watched",
      label: "Not watched",
      tone: "red",
      line: "Our rescue bot isn't watching this vault right now. Your money is safe in the vault; your loan is not protected.",
      action: "retry",
    };
  }
  if (row.readiness.funds !== "ok" || i.usdcEmpty) {
    return { id: "needs-usdc", label: "Needs USDC", tone: "amber", line: `Your vault has ${usdc} USDC; one rescue can use up to ${maxPerRescue}.`, action: "usdc" };
  }
  if (row.readiness.gas !== "ok" || i.gasEmpty) {
    return { id: "needs-gas", label: "Needs gas", tone: "amber", line: "Your rescue wallet is low on gas money.", action: "gas" };
  }
  if (row.readiness.debt === "none" || i.hf === null) {
    return { id: "nothing", label: "Nothing to protect", tone: "grey", line: `No USDC debt on ${chain} right now.`, action: "none" };
  }
  if (row.readiness.debt === "other") {
    return { id: "nothing", label: "Nothing to protect", tone: "grey", line: `Your debt on ${chain} isn't USDC, so Backstop can't repay it.`, action: "none" };
  }
  const hf = i.hf !== undefined ? i.hf : statusHf(row);
  if (hf !== null && hf < 1) {
    return { id: "at-risk", label: "At risk", tone: "red", line: "Health is below 1.00; the loan can be liquidated. Backstop repays within your limits.", action: "aave" };
  }
  const line = hf !== null && hf < Number(trigger) ? `Below ${trigger}: Backstop is stepping in within your limits.` : `Healthy. Backstop checks every 30 seconds and steps in below ${trigger}.`;
  return { id: "protected", label: "Protected", tone: "green", line, action: "none" };
}
