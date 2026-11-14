"use client";

import { formatUsdc } from "@backstop/core";
import { Check, Circle } from "lucide-react";
import { useEffect, useState } from "react";
import { usePolicyContext } from "@/components/app/policy-context";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { closeFlow, lastRequestAt, type CloseStepId } from "@/lib/close-flow";
import { nearText } from "@/lib/create-vault";
import { formatDuration } from "@/lib/format";
import { prepareClose, preparePause, prepareUnpause, prepareWithdraw } from "@/lib/review";
import { cn } from "@/lib/utils";

/** Seconds since 1970, refreshed every second while mounted (drives the countdown). */
function useNowSecs(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * "Close vault & get your money back": the contract's real rules as four plain steps with live status. Each action opens the
 * usual review; the waiting step is a countdown, never an error.
 */
export function CloseVault() {
  const { owner, policyId, snap, openReview, forget, reviewOpen } = usePolicyContext();
  const now = useNowSecs();
  if (!owner || !policyId || !snap) return null;

  const flow = closeFlow({
    paused: snap.limits.paused,
    usdcBalance: snap.usdcBalance,
    lastRequestAt: lastRequestAt(snap.status),
    lastBridgeAt: Number(snap.status.last_bridge_at),
    nowSecs: now,
  });
  const deposit = nearText(snap.account.amount, 2);

  const act: Record<CloseStepId, { label: string; run: () => void } | null> = {
    pause: {
      label: "Pause rescues",
      run: () => openReview({ kind: "pause", prepare: () => preparePause(policyId, owner), onSuccess: () => toast.success("Rescues are paused. Next, withdraw your USDC.") }),
    },
    withdraw: {
      label: `Withdraw ${formatUsdc(snap.usdcBalance)} USDC`,
      run: () =>
        openReview({
          kind: "withdraw",
          prepare: () => prepareWithdraw(policyId, owner, formatUsdc(snap.usdcBalance)),
          onSuccess: () => toast.success(`${formatUsdc(snap.usdcBalance)} USDC is back in your NEAR wallet.`),
        }),
    },
    wait: null,
    close: {
      label: "Close vault",
      run: () =>
        openReview({
          kind: "close",
          prepare: () => prepareClose(policyId, owner),
          onSuccess: () => {
            toast.success(`Vault closed. ${deposit} returned to ${owner}.`);
            forget(policyId);
          },
        }),
    },
  };

  return (
    <div className="space-y-4">
      <p>Gets your USDC and your {deposit} deposit back, then deletes the vault for good.</p>
      <ol className="space-y-3">
        {flow.steps.map((step, i) => {
          const action = step.state === "current" ? act[step.id] : null;
          return (
            <li key={step.id} className="flex gap-3">
              <span
                className={cn(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs",
                  step.state === "done" && "border-safe/40 bg-safe-bg text-safe",
                  step.state === "current" && "border-primary text-primary",
                  step.state === "todo" && "text-muted-foreground",
                )}
              >
                {step.state === "done" ? <Check className="size-3.5" aria-hidden /> : step.state === "current" ? i + 1 : <Circle className="size-2" aria-hidden />}
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className={cn("text-sm font-medium", step.state === "todo" && "text-muted-foreground")}>{step.title}</p>
                <p className="text-sm text-muted-foreground">{step.detail}</p>
                {step.id === "wait" && flow.waitSecs > 0 && snap.limits.paused ? (
                  <p role="timer" className="text-sm font-medium tabular-nums">
                    Ready in {formatDuration(flow.waitSecs)}
                  </p>
                ) : null}
                {action ? (
                  <Button
                    size="sm"
                    disabled={reviewOpen}
                    className={step.id === "close" ? "bg-danger text-white" : undefined}
                    onClick={action.run}
                  >
                    {action.label}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {snap.limits.paused && !flow.ready ? (
        <button
          type="button"
          disabled={reviewOpen}
          onClick={() => openReview({ kind: "unpause", prepare: () => prepareUnpause(policyId, owner) })}
          className="text-sm underline underline-offset-4 hover:text-foreground disabled:opacity-50"
        >
          Changed your mind? Resume rescues
        </button>
      ) : null}
    </div>
  );
}
