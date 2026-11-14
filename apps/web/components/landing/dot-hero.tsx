"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  END,
  GHOST_END,
  LIQUIDATION,
  TRIGGER,
  V_MAX,
  V_MIN,
  X_LIQUIDATED,
  X_RECOVERED,
  X_TRIGGER,
  ghostAt,
  healthAt,
  phaseAt,
  type Phase,
} from "@/components/landing/rescue-curve";

/**
 * The landing hero: an example "loan health" chart drawn as round dots on a fixed grid, on one canvas
 * that fills the hero behind the headline. At the top of the page the story plays on a loop; once the
 * visitor scrolls, the scroll position drives it (fall, "Backstop steps in", recovery, and the dim red
 * path the same loan takes without Backstop). The grid, rules and labels are drawn once per resize; each
 * frame only adds the moving dots, and nothing is drawn while the hero is off screen.
 * With prefers-reduced-motion the hero is one screen tall and shows the finished picture.
 */

const LOOP_MS = 11_000;
/** How much of the line is already drawn when scroll takes over at the top of the page. */
const P_SCROLL_START = X_TRIGGER - 0.1;

/** Loop time to drawn fraction: fall, a slower rescue stretch, recovery, then a hold on the finished picture. */
function loopProgress(t: number): number {
  if (t < 2800) return X_TRIGGER * (t / 2800);
  if (t < 5200) return X_TRIGGER + (X_RECOVERED - X_TRIGGER) * ((t - 2800) / 2400);
  if (t < 7000) return X_RECOVERED + (1 - X_RECOVERED) * ((t - 5200) / 1800);
  return 1;
}

const STATUS: Record<Phase, string> = {
  falling: "Falling",
  moving: "Backstop moving your USDC",
  repaying: "Repaying your loan",
  saved: "Safe again",
};

type Palette = { fg: string; muted: string; accent: string; danger: string; font: string };

function readPalette(el: HTMLElement): Palette {
  const root = getComputedStyle(document.documentElement);
  const v = (name: string) => root.getPropertyValue(name).trim();
  return { fg: v("--foreground"), muted: v("--muted-foreground"), accent: v("--primary"), danger: v("--danger"), font: getComputedStyle(el).fontFamily };
}

/** Grid geometry shared by the static layer and the moving dots. */
type Grid = {
  pitch: number;
  dot: number;
  rows: number;
  /** First and last grid column the chart uses, so the line starts and ends inside the view. */
  first: number;
  last: number;
  x: (col: number) => number;
  y: (row: number) => number;
  rowOf: (health: number) => number;
};

function makeGrid(width: number, height: number): Grid {
  const small = width < 640;
  const pitch = small ? 7 : 9;
  const cols = Math.floor(width / pitch);
  const rows = Math.floor(height / pitch);
  const inset = Math.max(2, Math.round(cols * (small ? 0.05 : 0.07)));
  /** On phones the chart sits under the headline; on wide screens it runs behind it. */
  const top = rows * (small ? 0.57 : 0.24);
  const bottom = rows * (small ? 0.93 : 0.92);
  const offsetX = (width - (cols - 1) * pitch) / 2;
  const offsetY = (height - (rows - 1) * pitch) / 2;
  return {
    pitch,
    dot: small ? 1.25 : 1.5,
    rows,
    first: inset,
    last: cols - 1 - inset,
    x: (col) => offsetX + col * pitch,
    y: (row) => offsetY + row * pitch,
    rowOf: (health) => Math.round(top + ((V_MAX - health) / (V_MAX - V_MIN)) * (bottom - top)),
  };
}

/** Fills one batch of same-colored dots. */
function dots(ctx: CanvasRenderingContext2D, points: [number, number][], radius: number, color: string, alpha: number) {
  if (points.length === 0) return;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (const [x, y] of points) {
    ctx.moveTo(x + radius, y);
    ctx.arc(x, y, radius, 0, Math.PI * 2);
  }
  ctx.fill();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, pal: Palette, align: CanvasTextAlign = "right") {
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.font = `500 11px ${pal.font}`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0.08em";
  ctx.fillText(text.toUpperCase(), x, y);
}

/** The parts that never move: the faint dot grid, the trigger and liquidation rules, and their labels. */
function drawStatic(ctx: CanvasRenderingContext2D, width: number, height: number, g: Grid, pal: Palette) {
  ctx.clearRect(0, 0, width, height);
  const cols = Math.floor(width / g.pitch);
  const field: [number, number][] = [];
  for (let r = 0; r < g.rows; r += 2) for (let c = r % 4 === 0 ? 0 : 1; c < cols; c += 2) field.push([g.x(c), g.y(r)]);
  dots(ctx, field, g.dot * 0.55, pal.muted, 0.16);

  const rule = (row: number): [number, number][] => Array.from({ length: Math.ceil(cols / 2) }, (_, i) => [g.x(i * 2), g.y(row)]);
  const triggerRow = g.rowOf(TRIGGER);
  const liqRow = g.rowOf(LIQUIDATION);
  dots(ctx, rule(triggerRow), g.dot * 0.8, pal.muted, 0.55);
  dots(ctx, rule(liqRow), g.dot * 0.8, pal.danger, 0.75);
  const edge = width - Math.max(16, g.x(0) + 8);
  label(ctx, "Your trigger", edge, g.y(triggerRow) - 12, pal.muted, pal);
  label(ctx, "Liquidation", edge, g.y(liqRow) - 12, pal.danger, pal);
  ctx.globalAlpha = 1;
}

/** The moving parts, drawn up to progress p (0..1 across the chart). */
function drawStory(ctx: CanvasRenderingContext2D, g: Grid, p: number, pal: Palette) {
  const span = g.last - g.first;
  const head = g.first + Math.round(p * span);
  const triggerCol = g.first + Math.round(X_TRIGGER * span);
  const liqRow = g.rowOf(LIQUIDATION);

  const line: [number, number][] = [];
  const rescue: [number, number][] = [];
  const shade: [number, number][][] = Array.from({ length: 10 }, () => []);
  let prev: number | null = null;
  for (let c = g.first; c <= head; c++) {
    const x = (c - g.first) / span;
    const row = g.rowOf(healthAt(x));
    const from: number = prev ?? row;
    const step = row >= from ? 1 : -1;
    const into = x >= X_TRIGGER && x < X_RECOVERED ? rescue : line;
    for (let r = from === row ? row : from + step; step > 0 ? r <= row : r >= row; r += step) into.push([g.x(c), g.y(r)]);
    for (let k = 0; k < shade.length; k++) if (row + 1 + k < liqRow) shade[k]?.push([g.x(c), g.y(row + 1 + k)]);
    prev = row;
  }
  shade.forEach((points, k) => dots(ctx, points, g.dot * 0.8, pal.fg, 0.26 * (1 - k / shade.length)));

  const ghost: [number, number][] = [];
  for (let c = triggerCol + 1; c <= head; c++) ghost.push([g.x(c), g.y(g.rowOf(ghostAt((c - g.first) / span)))]);
  dots(ctx, ghost, g.dot, pal.danger, 0.6);
  dots(ctx, line, g.dot * 1.6, pal.fg, 0.95);
  dots(ctx, rescue, g.dot * 1.6, pal.accent, 1);

  const headColor = p >= X_TRIGGER && p < X_RECOVERED ? pal.accent : pal.fg;
  const headPoint: [number, number] = [g.x(head), g.y(g.rowOf(healthAt(p)))];
  dots(ctx, [headPoint], g.dot * 3.2, headColor, 0.22);
  dots(ctx, [headPoint], g.dot * 1.9, headColor, 1);

  if (p >= X_TRIGGER) {
    const x = g.x(triggerCol);
    const y = g.y(g.rowOf(TRIGGER));
    ctx.globalAlpha = 1;
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, g.pitch * 0.95, 0, Math.PI * 2);
    ctx.stroke();
    label(ctx, "Backstop steps in", x - g.pitch * 1.6, y + g.pitch * 2.4, pal.accent, pal);
  }
  if (p >= X_RECOVERED + 0.04) label(ctx, "Collateral saved", g.x(g.last), g.y(g.rowOf(END)) - g.pitch * 3, pal.fg, pal);
  if (p >= X_LIQUIDATED) label(ctx, "Without Backstop", g.x(g.last), Math.min(g.y(g.rows - 2), g.y(g.rowOf(GHOST_END)) + g.pitch * 2.4), pal.danger, pal);
  ctx.globalAlpha = 1;
}

export function DotHero({ children }: { children: ReactNode }) {
  const trackRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [readout, setReadout] = useState({ health: END.toFixed(2), phase: "saved" as Phase });
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const track = trackRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const layer = document.createElement("canvas");
    const layerCtx = layer.getContext("2d");
    if (!track || !canvas || !ctx || !layerCtx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let palette = readPalette(canvas);
    let width = 0;
    let height = 0;
    let grid = makeGrid(1, 1);
    let drawn = -1;
    let current = 1;
    let frame = 0;
    let visible = true;
    const began = performance.now();

    const paint = (p: number) => {
      drawn = p;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(layer, 0, 0, width, height);
      drawStory(ctx, grid, p, palette);
      const health = healthAt(p).toFixed(2);
      const phase = phaseAt(p);
      setReadout((r) => (r.health === health && r.phase === phase ? r : { health, phase }));
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      if (width === 0 || height === 0) return;
      for (const [el, c] of [[canvas, ctx], [layer, layerCtx]] as const) {
        el.width = Math.round(width * dpr);
        el.height = Math.round(height * dpr);
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      grid = makeGrid(width, height);
      drawStatic(layerCtx, width, height, grid, palette);
      paint(current);
    };

    /** 0 at the top of the page, 1 when the hero has been scrolled through. */
    const scrollFraction = () => {
      const span = track.offsetHeight - window.innerHeight;
      return span <= 0 ? 0 : Math.min(1, Math.max(0, -track.getBoundingClientRect().top / span));
    };

    const tick = (now: number) => {
      const f = scrollFraction();
      setScrolled(f > 0.02);
      const target = f <= 0.02 ? loopProgress((now - began) % LOOP_MS) : P_SCROLL_START + (1 - P_SCROLL_START) * Math.min(1, f / 0.8);
      /** Ease toward the target so neither the loop nor the scroll ever jumps; only the loop restart snaps back. */
      current = target < current - 0.5 && f <= 0.02 ? target : current + (target - current) * 0.14;
      if (Math.abs(target - current) < 0.0008) current = target;
      if (Math.abs(current - drawn) > 0.0004) paint(current);
      if (visible) frame = requestAnimationFrame(tick);
    };

    const start = () => {
      cancelAnimationFrame(frame);
      if (reduce.matches) {
        current = 1;
        paint(1);
      } else if (visible) frame = requestAnimationFrame(tick);
    };

    const refresh = () => {
      palette = readPalette(canvas);
      resize();
    };
    const sizeWatch = new ResizeObserver(resize);
    sizeWatch.observe(canvas);
    const viewWatch = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      start();
    });
    viewWatch.observe(track);
    const themeWatch = new MutationObserver(refresh);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    reduce.addEventListener("change", start);
    void document.fonts.ready.then(refresh);

    return () => {
      cancelAnimationFrame(frame);
      sizeWatch.disconnect();
      viewWatch.disconnect();
      themeWatch.disconnect();
      reduce.removeEventListener("change", start);
    };
  }, []);

  return (
    <section ref={trackRef} className="relative h-[190svh] motion-reduce:h-auto">
      <div className="sticky top-14 h-[calc(100svh-3.5rem)] min-h-[34rem] overflow-hidden">
        <canvas ref={canvasRef} aria-hidden className="absolute inset-0 size-full font-mono" />
        <p className="sr-only">
          Example chart: a loan&apos;s health falls toward the liquidation line. When it drops below the owner&apos;s trigger, Backstop
          steps in, moves spare USDC from NEAR to the loan chain and repays part of the loan. Health recovers and the collateral
          is kept. Without Backstop the same loan would have been liquidated.
        </p>
        <div className="relative flex flex-col items-center px-4 pt-7 text-center sm:h-full sm:justify-center sm:pb-[26svh] sm:pt-0">
          <div className="relative isolate flex max-w-full flex-col items-center">
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-x-10 -inset-y-10 -z-10 hidden sm:block lg:-inset-x-32"
              style={{
                background:
                  "radial-gradient(closest-side, color-mix(in oklab, var(--color-background) 78%, transparent) 55%, color-mix(in oklab, var(--color-background) 55%, transparent) 78%, transparent)",
              }}
            />
            {children}
          </div>
          <p aria-hidden className="t-label mt-5 inline-flex max-w-full items-center gap-2.5 text-muted-foreground sm:absolute sm:left-6 sm:top-5 sm:mt-0">
            <span className="rounded border px-1.5 py-0.5">Example</span>
            <span>
              Loan health <span className="t-num text-foreground">{readout.health}</span>
            </span>
            <span className={`truncate ${readout.phase === "falling" ? "" : "text-primary"}`}>{STATUS[readout.phase]}</span>
          </p>
        </div>
        <p
          aria-hidden
          className={`t-label absolute inset-x-0 bottom-4 text-center text-muted-foreground transition-opacity duration-500 motion-reduce:hidden ${scrolled ? "opacity-0" : "opacity-100"}`}
        >
          Scroll to step through it
        </p>
      </div>
    </section>
  );
}
