"use client";

import { FundStep } from "@/components/app/actions";
import { NearStep } from "@/components/app/connect-steps";
import { AdvancedSection, type AdvancedState } from "@/components/app/home";
import { ProtectDone, ProtectStep } from "@/components/app/policy-step";
import { StepProgress } from "@/components/app/step-card";

/** The three setup steps: only the current one is open, finished ones are one line. */
export function Wizard({ stage, advanced }: { stage: "connect" | "protect" | "fund"; advanced: AdvancedState }) {
  return (
    <div className="space-y-4">
      <StepProgress n={stage === "connect" ? 1 : stage === "protect" ? 2 : 3} />
      <NearStep />
      {stage === "protect" ? <ProtectStep openAdvanced={advanced.open} /> : null}
      {stage === "fund" ? (
        <>
          <ProtectDone />
          <FundStep />
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">You approve every action in your wallet; we never ask for a seed phrase.</p>
      {stage !== "connect" ? <AdvancedSection advanced={advanced} /> : null}
    </div>
  );
}
