"use client";

import { useEffect, useRef, useState } from "react";
import { formatHf } from "@/lib/format";

interface Props {
  /** null = no debt */
  hf: number | null;
  trigger: number | null;
  target: number | null;
  /** A rescue is running: the needle pulses. */
  rescuing?: boolean;
  /** Text under the number when the value is old, for example "Updated 40 s ago". The gauge dims to half. */
  staleLabel?: string;
}

const CX = 120;
const CY = 120;
const R = 92;
const STROKE = 16;

function point(t: number, radius = R): [number, number] {
  const a = Math.PI * Math.min(1, Math.max(0, t));
  return [CX - radius * Math.cos(a), CY - radius * Math.sin(a)];
}

function arc(t1: number, t2: number): string {
  const [x1, y1] = point(t1);
  const [x2, y2] = point(t2);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

function zoneOf(hf: number | null, trigger: number | null): { label: string; color: string } {
  if (hf === null) return { label: "No debt", color: "var(--color-safe)" };
  if (hf < 1) return { label: "Liquidatable", color: "var(--color-danger)" };
  if (trigger !== null && hf < trigger) return { label: "Rescue zone", color: "var(--color-warn)" };
  return { label: "Healthy", color: "var(--color-safe)" };
}

/** Eases a number toward `value` over 600 ms. Reduced motion, and the very first render, show the value at once. */
function useCountUp(value: number | null): number | null {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (value === null || start === null || start === value || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      from.current = value;
      const id = requestAnimationFrame(() => setShown(value));
      return () => cancelAnimationFrame(id);
    }
    const t0 = performance.now();
    let raf = requestAnimationFrame(function step(now) {
      const p = Math.min(1, (now - t0) / 600);
      setShown(start + (value - start) * (1 - (1 - p) ** 3));
      if (p < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    });
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return shown;
}

/** Semicircle health gauge: red below 1.00, amber up to the rescue level, green above. The hero of the app's home screen. */
export function HfGauge({ hf, trigger, target, rescuing = false, staleLabel }: Props) {
  const max = Math.max(3, (target ?? 0) * 1.4, (trigger ?? 0) * 1.6);
  const t = (v: number) => v / max;
  const amberEnd = trigger ?? 1;
  const zone = zoneOf(hf, trigger);
  const markerT = hf === null ? 1 : t(Math.min(hf, max));
  const [lx0, ly0] = point(0);
  const number = useCountUp(hf);
  const markers = [
    trigger !== null ? { v: trigger, label: "Rescue at" } : null,
    target !== null ? { v: target, label: "Repay until" } : null,
  ].filter((m): m is { v: number; label: string } => m !== null);

  return (
    <svg
      viewBox="0 0 240 150"
      className="w-full max-w-sm overflow-visible transition-opacity duration-200 sm:max-w-md"
      style={{ opacity: staleLabel ? 0.5 : 1 }}
      role="img"
      aria-label={`Health ${hf === null ? "not applicable, no debt" : formatHf(hf)}. ${zone.label}.${staleLabel ? ` ${staleLabel}.` : ""}`}
    >
      <path d={arc(0, 1)} fill="none" stroke="var(--color-muted)" strokeWidth={STROKE} strokeLinecap="round" />
      <path d={arc(0, t(1))} fill="none" stroke="var(--color-danger)" strokeOpacity={0.85} strokeWidth={STROKE} />
      {amberEnd > 1 && <path d={arc(t(1), t(amberEnd))} fill="none" stroke="var(--color-warn)" strokeOpacity={0.85} strokeWidth={STROKE} />}
      <path d={arc(t(amberEnd), 1)} fill="none" stroke="var(--color-safe)" strokeOpacity={0.85} strokeWidth={STROKE} />
      {markers.map((m, i) => {
        const [x1, y1] = point(t(m.v), R - STROKE / 2 - 4);
        const [x2, y2] = point(t(m.v), R + STROKE / 2 + 3);
        const [tx, ty] = point(t(m.v), R + STROKE / 2 + 14 + i * 2);
        return (
          <g key={m.label}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--color-foreground)" strokeWidth={2} />
            <text x={tx} y={ty} textAnchor="middle" fontSize={8.5} fill="var(--color-muted-foreground)">
              {m.label} {m.v.toFixed(2)}
            </text>
          </g>
        );
      })}
      <g className={`gauge-needle${rescuing ? " gauge-pulse" : ""}`} style={{ transformOrigin: `${CX}px ${CY}px`, transform: `rotate(${180 * markerT}deg)` }}>
        <circle cx={lx0} cy={ly0} r={9} fill="var(--color-card)" stroke={zone.color} strokeWidth={4} />
      </g>
      <text
        x={CX}
        y={CY - 18}
        textAnchor="middle"
        fontSize={38}
        fontWeight={780}
        fill="var(--color-foreground)"
        style={{ fontVariantNumeric: "tabular-nums", fontFamily: "var(--font-display)" }}
      >
        {number === null ? "∞" : formatHf(number)}
      </text>
      <text x={CX} y={CY + 2} textAnchor="middle" fontSize={11} fill={zone.color} fontWeight={600}>
        {zone.label}
      </text>
      {staleLabel ? (
        <text x={CX} y={CY + 18} textAnchor="middle" fontSize={9} fill="var(--color-foreground)">
          {staleLabel}
        </text>
      ) : null}
    </svg>
  );
}
