/**
 * The guided "Close vault & get your money back" flow as a pure function of the vault's live numbers. It mirrors the real
 * contract rules in contracts/policy/src/lib.rs `close`: the vault must be paused, at least `CLOSE_QUIET_SECS` after the
 * last rescue, approval or bridge request, and hold at most `CLOSE_MAX_USDC_DUST` base units of USDC (under 0.01 USDC).
 * No network and no React: the screen only draws what this returns.
 */

/** `CLOSE_QUIET_SECS` in the contract. */
export const CLOSE_QUIET_SECS = 3_600;
/** `CLOSE_MAX_USDC_DUST` in the contract: 0.009999 USDC may stay behind. */
export const CLOSE_MAX_USDC_DUST = 9_999n;

export type CloseStepId = "pause" | "withdraw" | "wait" | "close";
export type CloseStepState = "done" | "current" | "todo";

export type CloseInput = {
  paused: boolean;
  /** USDC in the vault, 6 decimals. */
  usdcBalance: bigint;
  /** Latest of the vault's last rescue, approval and bridge request (unix seconds; 0 = never). */
  lastRequestAt: number;
  /** The last bridge request alone, to tell "money is on its way" apart from a plain wait. */
  lastBridgeAt: number;
  nowSecs: number;
};

export type CloseStep = { id: CloseStepId; state: CloseStepState; title: string; detail: string };

export type CloseFlow = {
  steps: CloseStep[];
  /** The step the person can act on now. */
  current: CloseStepId;
  /** Seconds until the safety window ends; 0 when it has passed or does not apply. */
  waitSecs: number;
  /** A bridge started inside the window: its USDC may still be on the way (or come back). */
  bridgeInFlight: boolean;
  /** Every rule holds: "Close vault" can be reviewed. */
  ready: boolean;
};

/** Seconds left of the one-hour window after the last request; 0 when it has passed or nothing ever ran. */
export function waitSecsLeft(lastRequestAt: number, nowSecs: number): number {
  return lastRequestAt <= 0 ? 0 : Math.max(0, lastRequestAt + CLOSE_QUIET_SECS - nowSecs);
}

export function closeFlow(i: CloseInput): CloseFlow {
  const waitSecs = waitSecsLeft(i.lastRequestAt, i.nowSecs);
  const bridgeInFlight = waitSecs > 0 && i.lastBridgeAt > 0 && i.nowSecs - i.lastBridgeAt < CLOSE_QUIET_SECS;
  const emptied = i.usdcBalance <= CLOSE_MAX_USDC_DUST;
  // The safety window only counts once rescues are paused: before that a new request can still restart it.
  const waited = i.paused && waitSecs === 0;
  const done: Record<CloseStepId, boolean> = { pause: i.paused, withdraw: emptied, wait: waited, close: false };
  const order: CloseStepId[] = ["pause", "withdraw", "wait", "close"];
  const current = order.find((id) => !done[id]) ?? "close";
  const copy: Record<CloseStepId, { title: string; detail: string }> = {
    pause: { title: "Pause protection", detail: i.paused ? "Rescues are paused." : "Stops Backstop from using your USDC. You can resume later if you change your mind." },
    withdraw: {
      title: "Withdraw your USDC",
      detail: emptied ? "Your vault is empty." : bridgeInFlight ? "Some USDC may still be on its way to your loan chain. Withdraw what is here now." : "All of it goes back to your NEAR wallet.",
    },
    wait: {
      title: "Wait for the safety window",
      detail: !i.paused
        ? "After the last rescue or money move, the vault waits one hour before it can be closed."
        : waitSecs > 0
          ? bridgeInFlight
            ? "Money is on its way. Try again in a few minutes."
            : "The vault waits one hour after its last rescue or money move."
          : "The safety window has passed.",
    },
    close: { title: "Close vault and get your deposit back", detail: "Your NEAR deposit returns to your wallet. The vault is deleted for good." },
  };
  const steps = order.map((id): CloseStep => ({ id, ...copy[id], state: done[id] ? "done" : id === current ? "current" : "todo" }));
  return { steps, current, waitSecs, bridgeInFlight, ready: done.pause && done.withdraw && done.wait };
}

/** The latest request time the contract tracks, from the three timestamps the status view exposes. */
export const lastRequestAt = (s: { last_rescue_at: bigint; last_bridge_at: bigint; last_approve_at: bigint }): number =>
  Math.max(Number(s.last_rescue_at), Number(s.last_bridge_at), Number(s.last_approve_at));
