"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format";

/** Time left until a unix-seconds deadline. Renders nothing until mounted (no hydration mismatch). */
export function Countdown({ endsAt }: { endsAt: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  if (now === null) return <span className="text-muted-foreground">…</span>;
  const left = endsAt - now;
  if (left <= 0) return <span className="text-safe">ready</span>;
  return <span className="text-warn">{formatDuration(left)} left</span>;
}
