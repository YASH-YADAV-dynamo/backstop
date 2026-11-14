"use client";

import { Check, ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { ChainLogo } from "@/components/landing/chain-logo";

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

const N = 120;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const wobble = (x: number) => 0.016 * Math.sin(x * 47) + 0.01 * Math.sin(x * 113 + 1);

/** Health before anything happens: a steady fall. */
function fallAt(x: number): number {
  return START - 1.04 * x + wobble(x);
}

const X_TRIGGER = (() => {
  for (let i = 0; i <= N; i++) if (fallAt(i / N) < TRIGGER) return i / N;
  return 0.5;
})();
/** Chart x positions (0..1) where the repay lands and where recovery is complete. */
const X_REPAY = X_TRIGGER + 0.12;
const X_RECOVERED = X_TRIGGER + 0.17;

/** The same loan without a rescue: it keeps falling from the trigger and ends below the liquidation line. */
const GHOST_END = 0.85;
function ghostAt(x: number): number {
  const f = clamp01((x - X_TRIGGER) / (1 - X_TRIGGER));
  return TRIGGER - (TRIGGER - GHOST_END) * f + wobble(x) * 0.5 * Math.min(1, f * 6);
}
const X_LIQUIDATED = (() => {
  for (let i = Math.round(X_TRIGGER * N); i <= N; i++) if (ghostAt(i / N) < LIQUIDATION) return i / N;
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
const GHOST_PATH = pathOf(ghostAt, X_TRIGGER, 1);
const Y_TRIGGER = yOf(TRIGGER);
const Y_LIQUIDATION = yOf(LIQUIDATION);
/** Faint horizontal guides above the trigger, for depth only. */
const GUIDES = [1.6, 1.45, 1.3].map(yOf);

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
  moving: { label: "Moving your USDC", cls: "border-primary/50 bg-primary/10 text-primary", caption: "Backstop moves your spare USDC from NEAR to your loan chain." },
  repaying: { label: "Repaying your loan", cls: "border-primary/50 bg-primary/10 text-primary", caption: "It repays part of the loan, inside the limits you set." },
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
  const liquidatedShown = p >= X_LIQUIDATED;
  const clip = `${uid}-clip`;
  const stroke = `${uid}-stroke`;
  const fill = `${uid}-fill`;
  const danger = `${uid}-danger`;
  const liveColor = health < TRIGGER ? "var(--color-warn)" : "var(--color-safe)";

  return (
    <figure className="relative w-full min-w-0">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-4 -inset-y-10 -z-10 opacity-80 blur-3xl sm:-inset-x-10"
        style={{
          background:
            "radial-gradient(45% 55% at 30% 35%, color-mix(in oklab, var(--color-primary) 26%, transparent), transparent 70%), radial-gradient(40% 50% at 78% 60%, color-mix(in oklab, var(--color-safe) 16%, transparent), transparent 70%)",
        }}
      />
      <figcaption className="sr-only">
        Example: a loan&apos;s health falls from 1.62 toward the liquidation line at 1.00. When it drops below 1.15, Backstop moves
        the owner&apos;s spare USDC from NEAR to the loan chain and repays part of the loan. Health recovers to 1.35 and the
        collateral is kept. Without Backstop the same loan would have been liquidated.
      </figcaption>

      <div
        aria-hidden
        className="overflow-hidden rounded-2xl border bg-card/85 text-left shadow-2xl shadow-black/25 ring-1 ring-inset ring-white/5 backdrop-blur sm:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-3 px-4 pt-4 sm:px-7 sm:pt-7">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground sm:text-base">Loan health</p>
            <div className="mt-1 flex items-center gap-3 sm:gap-4">
              <span className="font-display text-4xl leading-none tabular-nums sm:text-5xl">{health.toFixed(2)}</span>
              <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium sm:px-3 sm:text-sm ${status.cls}`}>
                <span className={`size-1.5 rounded-full bg-current ${rescuing ? "pulse-dot" : ""}`} />
                {status.label}
              </span>
            </div>
          </div>
          <span className="shrink-0 rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">Example</span>
        </div>

        <div className="relative mt-4 h-60 sm:mt-6 sm:h-80 lg:h-[23rem]">
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
                <stop offset="10%" stopColor="var(--color-safe)" stopOpacity="0.22" />
                <stop offset={`${Y_LIQUIDATION}%`} stopColor="var(--color-safe)" stopOpacity="0" />
              </linearGradient>
              <linearGradient id={danger} gradientUnits="userSpaceOnUse" x1="0" y1={Y_LIQUIDATION} x2="0" y2="100">
                <stop offset="0%" stopColor="var(--color-danger)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--color-danger)" stopOpacity="0.08" />
              </linearGradient>
            </defs>

            {GUIDES.map((y) => (
              <line key={y} x1="0" x2="100" y1={y} y2={y} stroke="var(--color-border)" strokeWidth="1" opacity="0.5" vectorEffect="non-scaling-stroke" />
            ))}
            <rect x="0" y={Y_LIQUIDATION} width="100" height={100 - Y_LIQUIDATION} fill={`url(#${danger})`} />
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
                strokeWidth="2"
                strokeDasharray="3 6"
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

          <span
            className="absolute left-4 -translate-y-full pb-1 text-[11px] leading-none text-muted-foreground sm:left-7 sm:pb-1.5 sm:text-sm"
            style={{ top: `${Y_TRIGGER}%` }}
          >
            Your trigger
          </span>
          <span className="absolute left-4 pt-2 text-xs font-medium leading-none text-danger sm:left-7 sm:pt-3 sm:text-base" style={{ top: `${Y_LIQUIDATION}%` }}>
            Liquidation zone
          </span>

          {/* Where Backstop steps in: a callout joined to the point where health crosses the trigger. */}
          <div className={shown(p >= X_TRIGGER)}>
            <span className="absolute w-px bg-primary/60" style={{ left: `${X_TRIGGER * 100}%`, top: "16%", height: `${Y_TRIGGER - 16}%` }} />
            <span
              className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-primary sm:size-4"
              style={{ left: `${X_TRIGGER * 100}%`, top: `${Y_TRIGGER}%` }}
            />
            <span
              className="absolute inline-flex -translate-x-4 items-center gap-1.5 whitespace-nowrap rounded-full bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground shadow-lg shadow-black/20 sm:gap-2 sm:px-4 sm:py-2 sm:text-base"
              style={{ left: `${X_TRIGGER * 100}%`, top: "8%" }}
            >
              <ShieldCheck className="size-3.5 sm:size-5" />
              Backstop steps in
            </span>
          </div>

          {/* The same loan without Backstop. */}
          <span
            className={`absolute mr-3.5 whitespace-nowrap pt-2 text-[11px] leading-none text-muted-foreground sm:mr-5 sm:pt-3.5 sm:text-sm ${shown(liquidatedShown)}`}
            style={{ top: `${Y_LIQUIDATION}%`, right: `${(1 - X_LIQUIDATED) * 100}%` }}
          >
            Without Backstop
          </span>
          <span
            className={`absolute grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-danger text-white sm:size-6 ${shown(liquidatedShown)}`}
            style={{ left: `${X_LIQUIDATED * 100}%`, top: `${Y_LIQUIDATION}%` }}
          >
            <X className="size-3 sm:size-4" strokeWidth={3} />
          </span>

          {/* The live point at the end of the drawn line. */}
          <span
            className="absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-card sm:size-[1.125rem]"
            style={{
              left: `${Math.min(p, 0.97) * 100}%`,
              top: `${yOf(healthAt(Math.min(p, 0.97)))}%`,
              background: liveColor,
              boxShadow: `0 0 0 5px color-mix(in oklab, ${liveColor} 25%, transparent), 0 0 24px ${liveColor}`,
            }}
          />

          <span
            className={`absolute right-4 inline-flex items-center gap-1.5 rounded-full border border-safe/40 bg-card px-2.5 py-1 text-xs font-semibold text-safe shadow-lg shadow-black/10 sm:right-7 sm:gap-2 sm:px-4 sm:py-2 sm:text-base ${shown(stepsDone)}`}
            style={{ top: `${yOf(END) + 5}%` }}
          >
            <Check className="size-3.5 sm:size-5" strokeWidth={3} />
            Collateral saved
          </span>
        </div>

        {/* Where the money goes: the NEAR vault on the left, the loan on the right. */}
        <div className="grid gap-4 border-t bg-muted/40 px-4 py-4 sm:px-7 sm:py-5">
          <div className="flex items-center gap-3 sm:gap-4">
            <div className="flex shrink-0 items-center gap-2 sm:gap-2.5">
              <span className="grid size-9 place-items-center rounded-full border bg-card sm:size-11">
                <ChainLogo chain="near" className="h-4 sm:h-5" />
              </span>
              <div>
                <p className="hidden text-xs text-muted-foreground sm:block">Your NEAR vault</p>
                <p className="text-sm font-medium sm:text-base">
                  <span className="sm:hidden">NEAR vault</span>
                  <span className="hidden sm:inline">Spare USDC</span>
                </p>
              </div>
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
                      className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-[0_0_10px_var(--color-primary)]"
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
            <div className="flex shrink-0 items-center gap-2 sm:gap-2.5">
              <div className="text-right">
                <p className="hidden text-xs text-muted-foreground sm:block">Your Base loan</p>
                <p className="text-sm font-medium sm:text-base">
                  <span className="sm:hidden">Base loan</span>
                  <span className="hidden sm:inline">{stepsDone ? "Partly repaid" : "Aave"}</span>
                </p>
              </div>
              <span className="grid size-9 place-items-center rounded-full border bg-card sm:size-11">
                <ChainLogo chain="base" className="h-4 sm:h-5" />
              </span>
            </div>
          </div>

          <div>
            <p className="min-h-10 text-sm text-muted-foreground sm:min-h-5">{status.caption}</p>
            <ol className="mt-3 grid grid-cols-3 gap-1.5 text-[11px] sm:gap-2 sm:text-xs">
              {STEPS.map((s, i) => {
                const done = stepsDone || i < stepIndex;
                const active = !stepsDone && i === stepIndex;
                return (
                  <li
                    key={s}
                    className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 leading-tight transition-colors sm:px-2.5 sm:py-2 ${
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
      </div>
    </figure>
  );
}
