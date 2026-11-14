/**
 * The example story the landing page draws: a loan's health falls, crosses the trigger, Backstop repays
 * part of the loan and health recovers, while the same loan without a rescue ends in liquidation.
 * Pure numbers for an illustration, not data. x runs from 0 to 1 across the chart.
 */

export const V_MIN = 0.8;
export const V_MAX = 1.75;
export const START = 1.62;
export const LOW = 1.11;
export const END = 1.35;
export const TRIGGER = 1.15;
export const LIQUIDATION = 1.0;
export const GHOST_END = 0.85;

const N = 240;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const wobble = (x: number) => 0.016 * Math.sin(x * 47) + 0.01 * Math.sin(x * 113 + 1);

/** Health before anything happens: a steady fall. */
function fallAt(x: number): number {
  return START - 1.04 * x + wobble(x);
}

function firstBelow(f: (x: number) => number, level: number, from: number): number {
  for (let i = Math.round(from * N); i <= N; i++) if (f(i / N) < level) return i / N;
  return 1;
}

/** Where health crosses the trigger, where the repay lands, and where recovery is complete. */
export const X_TRIGGER = firstBelow(fallAt, TRIGGER, 0);
export const X_REPAY = X_TRIGGER + 0.12;
export const X_RECOVERED = X_TRIGGER + 0.17;

/** The same loan without a rescue: it keeps falling from the trigger and ends below the liquidation line. */
export function ghostAt(x: number): number {
  const f = clamp01((x - X_TRIGGER) / (1 - X_TRIGGER));
  return TRIGGER - (TRIGGER - GHOST_END) * f + wobble(x) * 0.5 * Math.min(1, f * 6);
}
export const X_LIQUIDATED = firstBelow(ghostAt, LIQUIDATION, X_TRIGGER);

/** Health with Backstop: the same fall until the trigger, a short dip while money moves, then the repay. */
export function healthAt(x: number): number {
  if (x <= X_TRIGGER) return fallAt(x);
  if (x <= X_REPAY) return TRIGGER + (LOW - TRIGGER) * clamp01((x - X_TRIGGER) / (X_REPAY - X_TRIGGER)) + wobble(x) * 0.3;
  if (x <= X_RECOVERED) return LOW + (END - LOW) * ease((x - X_REPAY) / (X_RECOVERED - X_REPAY));
  return END + wobble(x) * 0.6 * clamp01((x - X_RECOVERED) * 8);
}

export type Phase = "falling" | "moving" | "repaying" | "saved";
export function phaseAt(p: number): Phase {
  if (p < X_TRIGGER) return "falling";
  if (p < X_REPAY) return "moving";
  if (p < X_RECOVERED) return "repaying";
  return "saved";
}
