/** In-memory sliding-window limiter per key (E.9: quote 10/min, status 60/min per IP). Resets on restart; good enough to blunt abuse of the 1Click quota. */
export type Limiter = { allow: (key: string, now?: number) => boolean };

export function createLimiter(max: number, windowMs = 60_000, maxKeys = 5_000): Limiter {
  const hits = new Map<string, number[]>();
  return {
    allow(key, now = Date.now()) {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.delete(key);
      hits.set(key, recent);
      while (hits.size > maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest === undefined) break;
        hits.delete(oldest);
      }
      return true;
    },
  };
}

/** Best-effort client key from proxy headers; "local" when none (dev). */
export function clientKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || request.headers.get("x-real-ip") || "local";
}
