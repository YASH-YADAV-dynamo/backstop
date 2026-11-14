/** Formatting shared by server and client. Deterministic (UTC) so hydration never mismatches. */

export function formatHf(hf: number): string {
  return Number.isFinite(hf) ? hf.toFixed(2) : "∞ (no debt)";
}

/** ISO 8601 -> "2026-11-12 14:03 UTC" */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatDuration(totalSecs: number): string {
  const s = Math.max(0, Math.round(totalSecs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function shortAddress(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}
