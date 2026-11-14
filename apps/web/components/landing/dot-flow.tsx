"use client";

import { useEffect, useRef } from "react";

/**
 * A band of dots streaming left to right on the same grid as the hero: USDC leaving the NEAR vault for
 * the loan chain. One canvas, about 30 frames a second, running only while the band is on screen.
 * With prefers-reduced-motion it draws a single still frame.
 */

const LANES = 7;
const PER_LANE = 5;
const TRAIL = 7;

function noise(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function DotFlow() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let visible = false;
    let lastPaint = 0;

    const paint = (now: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const root = getComputedStyle(document.documentElement);
      const accent = root.getPropertyValue("--primary").trim();
      const muted = root.getPropertyValue("--muted-foreground").trim();
      const pitch = width < 640 ? 7 : 9;
      const radius = width < 640 ? 1.25 : 1.5;
      const cols = Math.ceil(width / pitch);
      const laneGap = Math.max(2, Math.floor(height / pitch / (LANES + 1)));
      const dot = (c: number, row: number, r: number) => {
        ctx.moveTo(c * pitch + r, row * pitch);
        ctx.arc(c * pitch, row * pitch, r, 0, Math.PI * 2);
      };

      for (let lane = 0; lane < LANES; lane++) {
        const row = (lane + 1) * laneGap;
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = muted;
        ctx.beginPath();
        for (let c = lane % 2; c < cols; c += 2) dot(c, row, radius * 0.6);
        ctx.fill();
        ctx.fillStyle = accent;
        for (let k = 0; k < TRAIL; k++) {
          ctx.globalAlpha = 1 - k / TRAIL;
          ctx.beginPath();
          for (let i = 0; i < PER_LANE; i++) {
            const speed = 0.03 + noise(lane, i) * 0.04;
            const head = Math.floor((((now / 1000) * speed + noise(i, lane + 9)) % 1) * (cols + TRAIL));
            dot(head - k, row, k === 0 ? radius * 1.5 : radius);
          }
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      if (now - lastPaint > 33) {
        lastPaint = now;
        paint(now);
      }
      if (visible) frame = requestAnimationFrame(tick);
    };
    const start = () => {
      cancelAnimationFrame(frame);
      if (reduce.matches) paint(4000);
      else if (visible) frame = requestAnimationFrame(tick);
    };
    const viewWatch = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      start();
    });
    viewWatch.observe(canvas);
    reduce.addEventListener("change", start);
    paint(4000);

    return () => {
      cancelAnimationFrame(frame);
      viewWatch.disconnect();
      reduce.removeEventListener("change", start);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="block h-28 w-full sm:h-36" />;
}
