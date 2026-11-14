"use client";

import { Check, ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useState, useSyncExternalStore } from "react";

/**
 * Landing hero visual: an example "loan health over time" chart on a 10 second loop.
 * Health falls toward the liquidation zone, crosses the example trigger, Backstop moves USDC from the
 * NEAR vault to the loan chain and repays part of the loan, and health recovers. A dashed line shows
 * the same loan without Backstop ending in the liquidation zone. Labelled "Example": no data, nothing live.
 * The server render, the first frame and prefers-reduced-motion all show the finished picture.
 */

const LOOP_MS = 10_000;
/** The loop starts inside the final hold, so the whole story is readable before it replays. */
const FIRST_FRAME_MS = 8_600;

const V_MIN = 0.8;
const V_MAX = 1.75;
const START = 1.62;
const LOW = 1.11;
const END = 1.35;
const TRIGGER = 1.15;
const LIQUIDATION = 1.0;

/** Chart x positions (0..1) where the repay lands and where recovery is complete. */
const X_REPAY = 0.58;
const X_RECOVERED = 0.64;
const N = 120;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const wobble = (x: number) => 0.016 * Math.sin(x * 47) + 0.01 * Math.sin(x * 113 + 1);

/** Health without any rescue: a steady fall that ends below the liquidation line. */
function fallAt(x: number): number {
  return START - 0.78 * Math.pow(x, 1.25) + wobble(x) * (1 - x * 0.5);
}

const X_TRIGGER = (() => {
  for (let i = 0; i <= N; i++) if (fallAt(i / N) < TRIGGER) return i / N;
  return 0.5;
})();
const X_LIQUIDATED = (() => {
  for (let i = 0; i <= N; i++) if (fallAt(i / N) < LIQUIDATION) return i / N;
  return 0.9;
})();

/** Health with Backstop: same fall until the trigger, a short dip while money moves, then the repay. */
function healthAt(x: number): number {
  if (x <= X_TRIGGER) return fallAt(x);
  if (x <= X_REPAY) return TRIGGER + (LOW - TRIGGER) * clamp01((x - X_TRIGGER) / (X_REPAY - X_TRIGGER)) + wobble(x) * 0.3;
  if (x <= X_RECOVERED) return LOW + (END - LOW) * ease((x - X_REPAY) / (X_RECOVERED - X_REPAY));
  return END + wobble(x) * 0.6 * clamp01((x - X_RECOVERED) * 8);
}

/** Chart coordinates are percentages of the plot box, so HTML labels and the SVG share one scale. */
const yOf = (v: number) => ((V_MAX - v) / (V_MAX - V_MIN)) * 100;
const pathOf = (f: (x: number) => number, from: number, to: number) => {
  const pts: string[] = [];
  for (let i = Math.round(from * N); i <= Math.round(to * N); i++) pts.push(`${((i / N) * 100).toFixed(2)} ${yOf(f(i / N)).toFixed(2)}`);
  return `M ${pts.join(" L ")}`;
};

const HEALTH_PATH = pathOf(healthAt, 0, 1);
const AREA_PATH = `${HEALTH_PATH} L 100 100 L 0 100 Z`;
const GHOST_PATH = pathOf(fallAt, X_TRIGGER, 1);
const Y_TRIGGER = yOf(TRIGGER);
const Y_LIQUIDATION = yOf(LIQUIDATION);

/** How far the line is drawn (0..1) at loop time t. The rescue stretch is slowed down so it can be read. */
function progressAt(t: number): number {
  if (t < 2600) return X_TRIGGER * (t / 2600);
  if (t < 5000) return X_TRIGGER + (X_RECOVERED - X_TRIGGER) * ((t - 2600) / 2400);
  if (t < 6600) return X_RECOVERED + (1 - X_RECOVERED) * ((t - 5000) / 1600);
  return 1;
}

type Phase = "falling" | "moving" | "repaying" | "saved";
function phaseAt(p: number): Phase {
  if (p < X_TRIGGER) return "falling";
  if (p < X_REPAY) return "moving";
  if (p < X_RECOVERED) return "repaying";
  return "saved";
}

const STATUS: Record<Phase, { label: string; cls: string; caption: string }> = {
  falling: { label: "Falling", cls: "border-warn/40 bg-warn/10 text-warn", caption: "Prices drop and your loan health falls toward liquidation." },
  moving: { label: "Backstop is moving your USDC", cls: "border-primary/50 bg-primary/10 text-primary", caption: "Backstop moves your spare USDC from NEAR to your loan chain." },
  repaying: { label: "Repaying part of your loan", cls: "border-primary/50 bg-primary/10 text-primary", caption: "It repays part of the loan, inside the limits you set." },
  saved: { label: "Safe again", cls: "border-safe/40 bg-safe/10 text-safe", caption: "Health recovers. You keep your collateral." },
};

const STEPS = ["Health falls", "Your USDC moves", "Loan repaid"] as const;

const REDUCED = "(prefers-reduced-motion: reduce)";
function subscribeReduced(onChange: () => void) {
  const mq = window.matchMedia(REDUCED);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

const shown = (on: boolean) => `transition-opacity duration-300 ${on ? "opacity-100" : "opacity-0"}`;

export function HeroRescue() {
  const uid = useId();
  const [clock, setClock] = useState(FIRST_FRAME_MS);
  const reduce = useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );

  useEffect(() => {
    if (reduce) return;
    const begin = performance.now() - FIRST_FRAME_MS;
    let frame = requestAnimationFrame(function tick(now) {
      setClock((now - begin) % LOOP_MS);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [reduce]);

  const t = reduce ? FIRST_FRAME_MS : clock;
  const p = progressAt(t);
  const phase = phaseAt(p);
  const status = STATUS[phase];
  const health = healthAt(p);
  const rescuing = phase === "moving" || phase === "repaying";
  const stepIndex = phase === "falling" ? 0 : phase === "moving" ? 1 : 2;
  const stepsDone = phase === "saved";
  const ghostShown = p > X_TRIGGER + 0.04;
  const liquidatedShown = p >= X_LIQUIDATED;
  const clip = `${uid}-clip`;
  const stroke = `${uid}-stroke`;
  const fill = `${uid}-fill`;

  return (
    <figure className="relative w-full min-w-0">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-2 -z-10 rounded-[2rem] opacity-70 blur-2xl sm:-inset-6"
        style={{ background: "radial-gradient(60% 50% at 50% 40%, color-mix(in oklab, var(--color-primary) 22%, transparent), transparent 70%)" }}
      />
      <figcaption className="sr-only">
        Example: a loan&apos;s health falls from 1.62 toward the liquidation line at 1.00. When it drops below 1.15, Backstop moves
        the owner&apos;s spare USDC from NEAR to the loan chain and repays part of the loan. Health recovers to 1.35 and the
        collateral is kept. Without Backstop the same loan would have been liquidated.
      </figcaption>

      <div aria-hidden className="overflow-hidden rounded-2xl border bg-card shadow-xl shadow-black/10">
        <div className="flex items-start justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-5">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">Loan health</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="font-display num text-4xl leading-none sm:text-5xl">{health.toFixed(2)}</span>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${status.cls}`}>
                <span className={`size-1.5 rounded-full bg-current ${rescuing ? "pulse-dot" : ""}`} />
                {status.label}
              </span>
            </div>
          </div>
          <span className="shrink-0 rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">Example</span>
        </div>

        <div className="relative mt-4 h-60 sm:h-72">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full">
            <defs>
              <clipPath id={clip}>
                <rect x="0" y="0" width={p * 100} height="100" />
              </clipPath>
              <linearGradient id={stroke} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="100">
                <stop offset={`${Y_TRIGGER - 6}%`} stopColor="var(--color-safe)" />
                <stop offset={`${Y_TRIGGER + 1}%`} stopColor="var(--color-warn)" />
              </linearGradient>
              <linearGradient id={fill} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="100">
                <stop offset="10%" stopColor="var(--color-safe)" stopOpacity="0.2" />
                <stop offset={`${Y_LIQUIDATION}%`} stopColor="var(--color-safe)" stopOpacity="0" />
              </linearGradient>
            </defs>

            <rect x="0" y={Y_LIQUIDATION} width="100" height={100 - Y_LIQUIDATION} fill="var(--color-danger)" opacity="0.14" />
            <line x1="0" x2="100" y1={Y_LIQUIDATION} y2={Y_LIQUIDATION} stroke="var(--color-danger)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            <line
              x1="0"
              x2="100"
              y1={Y_TRIGGER}
              y2={Y_TRIGGER}
              stroke="var(--color-muted-foreground)"
              strokeWidth="1"
              strokeDasharray="4 5"
              opacity="0.7"
              vectorEffect="non-scaling-stroke"
            />

            <g clipPath={`url(#${clip})`}>
              <path d={AREA_PATH} fill={`url(#${fill})`} />
              <path
                d={GHOST_PATH}
                fill="none"
                stroke="var(--color-danger)"
                strokeWidth="1.75"
                strokeDasharray="3 5"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={HEALTH_PATH}
                fill="none"
                stroke={`url(#${stroke})`}
                strokeWidth="3"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          </svg>

          <span className="absolute left-4 -translate-y-full pb-1 text-[11px] leading-none text-muted-foreground sm:left-6 sm:text-xs" style={{ top: `${Y_TRIGGER}%` }}>
            Your trigger
          </span>
          <span className="absolute left-4 pt-2 text-xs font-medium leading-none text-danger sm:left-6 sm:text-sm" style={{ top: `${Y_LIQUIDATION}%` }}>
            Liquidation zone
          </span>

          {/* Where Backstop steps in: a callout joined to the point where health crosses the trigger. */}
          <div className={shown(p >= X_TRIGGER)}>
            <span
              className="absolute w-px bg-primary/60"
              style={{ left: `${X_TRIGGER * 100}%`, top: "21%", height: `${Y_TRIGGER - 21}%` }}
            />
            <span
              className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-primary"
              style={{ left: `${X_TRIGGER * 100}%`, top: `${Y_TRIGGER}%` }}
            />
            <span
              className="absolute inline-flex -translate-x-4 items-center gap-1.5 whitespace-nowrap rounded-full bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground shadow-lg shadow-black/20"
              style={{ left: `${X_TRIGGER * 100}%`, top: "12%" }}
            >
              <ShieldCheck className="size-3.5" />
              Backstop steps in
            </span>
          </div>

          {/* The same loan without Backstop. */}
          <span
            className={`absolute right-4 -translate-y-full pb-1.5 text-[11px] leading-none text-muted-foreground sm:right-6 sm:text-xs ${shown(ghostShown)}`}
            style={{ top: `${Y_LIQUIDATION}%` }}
          >
            Without Backstop
          </span>
          <span
            className={`absolute grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-danger text-white ${shown(liquidatedShown)}`}
            style={{ left: `${X_LIQUIDATED * 100}%`, top: `${Y_LIQUIDATION}%` }}
          >
            <X className="size-3" strokeWidth={3} />
          </span>

          {/* The live point at the end of the drawn line. */}
          <span
            className="absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-card"
            style={{
              left: `${Math.min(p, 0.985) * 100}%`,
              top: `${yOf(healthAt(Math.min(p, 0.985)))}%`,
              background: health < TRIGGER ? "var(--color-warn)" : "var(--color-safe)",
              boxShadow: `0 0 0 4px color-mix(in oklab, ${health < TRIGGER ? "var(--color-warn)" : "var(--color-safe)"} 25%, transparent)`,
            }}
          />

          <span
            className={`absolute right-4 inline-flex -translate-y-full items-center gap-1.5 rounded-full border border-safe/40 bg-card px-2.5 py-1 text-xs font-semibold text-safe sm:right-6 ${shown(stepsDone)}`}
            style={{ top: `${yOf(END) - 5}%` }}
          >
            <Check className="size-3.5" strokeWidth={3} />
            Collateral saved
          </span>
        </div>

        {/* Where the money goes: the NEAR vault on the left, the loan on the right. */}
        <div className="border-t bg-muted/40 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="shrink-0">
              <p className="text-xs text-muted-foreground">Your vault on NEAR</p>
              <p className="text-sm font-medium">Spare USDC</p>
            </div>
            <div className="relative h-6 min-w-0 flex-1">
              <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
              <span
                className="absolute left-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-primary"
                style={{ width: `${clamp01((p - X_TRIGGER) / (X_REPAY - X_TRIGGER)) * 100}%` }}
              />
              {phase === "moving"
                ? [0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary"
                      style={{ left: `${((t / 900 + i / 3) % 1) * 100}%` }}
                    />
                  ))
                : null}
              <span
                className={`absolute right-0 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-full bg-safe text-primary-foreground ${shown(stepsDone)}`}
              >
                <Check className="size-3" strokeWidth={3.5} />
              </span>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-xs text-muted-foreground">Your loan on Base</p>
              <p className="text-sm font-medium">{stepsDone ? "Partly repaid" : "Aave"}</p>
            </div>
          </div>

          <p className="mt-3 min-h-10 text-sm text-muted-foreground sm:min-h-5">{status.caption}</p>

          <ol className="mt-3 grid grid-cols-3 gap-1.5 text-[11px] sm:gap-2 sm:text-xs">
            {STEPS.map((s, i) => {
              const done = stepsDone || i < stepIndex;
              const active = !stepsDone && i === stepIndex;
              return (
                <li
                  key={s}
                  className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 leading-tight transition-colors sm:px-2.5 ${
                    active ? "border-primary/60 bg-primary/10 text-foreground" : done ? "border-safe/40 text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {done ? <Check className="size-3.5 shrink-0 text-safe" /> : <span className="num shrink-0 text-muted-foreground">{i + 1}</span>}
                  <span className="min-w-0">{s}</span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </figure>
  );
}
