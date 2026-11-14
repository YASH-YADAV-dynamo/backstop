"use client";

import { SUPPORTED_CHAIN_NAMES } from "@backstop/config/registry";
import { Check, Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { ChainSwitcher } from "@/components/app/chain-switcher";
import { CreateVault, creationOpen } from "@/components/app/create-vault";
import { usePolicyContext } from "@/components/app/policy-context";
import { DoneLine, StepCard } from "@/components/app/step-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { resolveChain } from "@/lib/chain";
import { NearRpcError } from "@/lib/near-rpc";
import { BAD_VAULT_INPUT } from "@/lib/policy-param";
import { prepareActivate } from "@/lib/review";
import { isNearAccountId } from "@/lib/validate";
import { ZodError } from "zod";

function describeReadError(err: unknown, policyId: string): string {
  if (err instanceof ZodError) {
    return `${policyId} exists but does not answer like a Backstop vault (${err.issues[0]?.path.join(".") || "unexpected shape"}). It may be an older vault or another contract: check the account id.`;
  }
  if (err instanceof NearRpcError) {
    if (/UNKNOWN_ACCOUNT|does not exist/i.test(err.message)) return `${policyId} does not exist on NEAR mainnet yet. Check the account id, or wait for the deployment.`;
    if (err.kind === "rejected") return `${policyId} is not a Backstop vault (${err.message}). Check the account id.`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** A heading, one sentence, and optionally an action: the shape of every vault state. */
function Notice({ tone = "default", heading, children, action }: { tone?: "default" | "warn" | "danger"; heading: string; children?: ReactNode; action?: ReactNode }) {
  const box = { default: "bg-muted/40", warn: "border-warn/30 bg-warn/5", danger: "border-danger/30 bg-danger/5" }[tone];
  return (
    <div role={tone === "default" ? undefined : "alert"} className={`space-y-2 rounded-lg border p-4 text-sm ${box}`}>
      <p className={`font-medium ${tone === "danger" ? "text-danger" : ""}`}>{heading}</p>
      {children ? <div className="text-muted-foreground">{children}</div> : null}
      {action ? <div className="flex flex-wrap items-center gap-3 pt-1">{action}</div> : null}
    </div>
  );
}

/** Paste a vault account. Collapsed: most people never need it. */
function PasteVault() {
  const { choose } = usePolicyContext();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">I already have a vault</summary>
      <form
        className="mt-3 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          const id = text.trim();
          if (!isNearAccountId(id)) {
            setError(BAD_VAULT_INPUT);
            return;
          }
          setError(null);
          choose(id);
          setText("");
        }}
      >
        <label htmlFor="policy-id" className="font-medium">
          Vault account
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="policy-id"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="alice.backstop.near"
            spellCheck={false}
            autoComplete="off"
            className="h-10 w-full min-w-0 rounded-md border bg-background px-3 font-mono text-sm sm:flex-1"
          />
          <Button type="submit" variant="outline">
            Open vault
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </details>
  );
}

function ChainPicker() {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Which loan?</p>
      <ChainSwitcher />
    </div>
  );
}

function NoVault() {
  return (
    <div className="space-y-3">
      {creationOpen() ? (
        <CreateVault />
      ) : (
        <Notice heading="Vault creation opens soon">You&apos;ll be able to open your Rescue vault right here. Check back shortly.</Notice>
      )}
      <PasteVault />
    </div>
  );
}

/** Three ticks that fill in while the new vault is set up; "Finish setup" appears if the second one stalls for a minute. */
function SetupChecklist({ rescueWalletReady, checksPassed, onFinish }: { rescueWalletReady: boolean; checksPassed: boolean; onFinish: () => void }) {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setStalled(true), 60_000);
    return () => clearTimeout(id);
  }, []);
  const items: Array<[string, boolean]> = [
    ["Vault created", true],
    ["Rescue wallet ready", rescueWalletReady],
    ["Safety checks passed", checksPassed],
  ];
  return (
    <div className="space-y-3 rounded-lg border bg-muted/40 p-4 text-sm" aria-live="polite">
      <ul className="space-y-2">
        {items.map(([text, done]) => (
          <li key={text} className="flex items-center gap-2">
            {done ? <Check className="size-4 text-safe" aria-hidden /> : <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
            <span className={done ? undefined : "text-muted-foreground"}>{text}</span>
          </li>
        ))}
      </ul>
      {stalled && !rescueWalletReady ? (
        <div className="space-y-2">
          <p className="text-muted-foreground">This is taking longer than usual. One more confirmation finishes it.</p>
          <Button onClick={onFinish}>Finish setup</Button>
        </div>
      ) : null}
    </div>
  );
}

/** What is wrong with (or still missing from) the selected vault. Renders nothing when it is ready. */
function VaultStatus({ openAdvanced }: { openAdvanced: (item: string) => void }) {
  const { policyId, query, snap, verified, activated, requestsLoading, forget, openReview } = usePolicyContext();

  if (policyId === null) {
    return requestsLoading ? <Looking /> : <NoVault />;
  }
  if (query.isError && !snap) {
    return (
      <div className="space-y-3">
        <Notice
          tone="danger"
          heading="We couldn't open this vault"
          action={
            <>
              <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
              <button type="button" onClick={() => forget(policyId)} className="text-xs underline underline-offset-4 hover:text-foreground">
                Stop listing it on this device
              </button>
            </>
          }
        >
          <span className="break-all">{policyId}</span> isn&apos;t a Backstop vault on NEAR mainnet. Check the spelling or pick another.
        </Notice>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Technical details</summary>
          <p className="mt-3 break-words text-muted-foreground">{describeReadError(query.error, policyId)}</p>
        </details>
        <PasteVault />
      </div>
    );
  }
  if (!snap) return <Looking />;
  if (resolveChain(snap.config.chain_id) === null) {
    return (
      <Notice tone="danger" heading="This vault's chain isn't supported">
        Backstop protects loans on {SUPPORTED_CHAIN_NAMES}; you can still pause and withdraw.
      </Notice>
    );
  }
  if (!verified) {
    return (
      <Notice
        tone="danger"
        heading="Don't fund this vault"
        action={
          <Button size="sm" variant="outline" onClick={() => openAdvanced("checks")}>
            See safety checks
          </Button>
        }
      >
        A safety check failed, so adding money is turned off.
      </Notice>
    );
  }
  if (!activated) {
    return <SetupChecklist key={snap.policyId} rescueWalletReady={false} checksPassed={verified} onFinish={() => openReview({ kind: "activate", prepare: () => prepareActivate(snap.policyId) })} />;
  }
  return null;
}

function Looking() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Looking for your Rescue vault">
      <p className="text-sm text-muted-foreground">Looking for your Rescue vault...</p>
      <Skeleton className="h-4 w-48" />
    </div>
  );
}

/** Step 2: pick the loan, then show the vault's state until it is safe and set up. */
export function ProtectStep({ openAdvanced }: { openAdvanced: (item: string) => void }) {
  return (
    <StepCard title="Find your Rescue vault" description="The vault holds your USDC on NEAR and enforces your limits.">
      <ChainPicker />
      <VaultStatus openAdvanced={openAdvanced} />
    </StepCard>
  );
}

/** Step 2, finished (shown on step 3). "Change" reopens the loan picker. */
export function ProtectDone() {
  const { policyId, chain } = usePolicyContext();
  const [open, setOpen] = useState(false);
  return (
    <DoneLine
      open={open}
      onChange={() => setOpen((o) => !o)}
      panel={
        <>
          <ChainPicker />
          <PasteVault />
        </>
      }
    >
      <span className="break-all">{policyId}</span> on {chain.name}, safety checks passed
    </DoneLine>
  );
}
