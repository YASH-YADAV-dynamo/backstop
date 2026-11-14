"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useLocalString } from "@/lib/use-client";

/**
 * The one safeguard shown in the app: before the first deposit, the owner confirms they understand the beta and the missing
 * audit. Remembered per NEAR account in this browser only (a convenience; clearing site data asks again).
 */
export function BetaGate({ owner, children }: { owner: string; children: ReactNode }) {
  const [acked, setAcked] = useLocalString(`backstop.beta-ack.${owner}`);
  if (acked === "1") return <>{children}</>;
  return (
    <div className="space-y-3 rounded-lg border bg-surface-2 p-4 text-sm">
      <p className="font-medium">One thing before your first deposit</p>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--color-primary)]" onChange={(e) => e.target.checked && setAcked("1")} />
        <span>I understand Backstop is in beta and its smart contracts are not yet audited.</span>
      </label>
      <p className="text-xs text-muted-foreground">Tick the box to continue.</p>
      <Link href="/docs/risks-and-limits" className="inline-block text-sm underline underline-offset-4 hover:text-foreground">
        Read the risks
      </Link>
    </div>
  );
}
