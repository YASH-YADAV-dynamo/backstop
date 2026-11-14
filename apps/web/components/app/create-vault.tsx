"use client";

import { LOAN_CHAINS } from "@backstop/config/registry";
import { randomSalt } from "@backstop/core";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { ConnectWalletButton } from "@/components/app/connect-steps";
import { GetNear } from "@/components/app/get-near";
import { useEvmIdentity } from "@/components/app/evm-identity";
import { usePolicyContext } from "@/components/app/policy-context";
import { StepCard } from "@/components/app/step-card";
import { ChainBadge } from "@/components/chain-badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { useNear } from "@/components/wallet/near-provider";
import { buildCreateBody, createBlockReason, createDeposit, DEFAULT_FIELDS, GAS_ALLOWANCE_YOCTO, nearText, returnedOnClose, type CreateFields } from "@/lib/create-vault";
import { getNearEnabled } from "@/lib/get-near";
import { hasFullAccessKey } from "@/lib/near-rpc";
import { PUBLIC_ENV } from "@/lib/public-env";
import { useDebt, useInvite, useNearAccount } from "@/lib/queries";
import { prepareCreateVault } from "@/lib/review";
import { useLocalString } from "@/lib/use-client";
import { cn } from "@/lib/utils";
import { parseEvmAddress } from "@/lib/validate";
import { ethereumWalletNearHint } from "@/lib/wallet-flow";
import { CREATE_STEPS, endedText, parsePending, pendingKey, stepOf, submitRequest, type CreateStep, type PendingCreate } from "@/lib/vault-requests";

const input = "h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm";

/** How long after the wallet answered we keep looking for the new account before saying it was not created. */
const ACCOUNT_WAIT_MS = 120_000;
const ACCOUNT_POLL_MS = 3_000;
/** Ended (failed / refunded) creations stay on the card this long. */
const ENDED_SHOWN_MS = 24 * 3_600_000;

/** Vault creation is configured on this site: setup key, published code (hash and size) and the bot. */
export const creationOpen = (): boolean =>
  Boolean(PUBLIC_ENV.vaultDeployerPk && PUBLIC_ENV.policyCodeHash && PUBLIC_ENV.policyCodeBytes && PUBLIC_ENV.agentId);

/** The refundable deposit, in plain words. Shown on the card and again in the review. */
export function DepositNote({ amount }: { amount: bigint }) {
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
      <p className="text-base font-semibold">Refundable deposit: {nearText(amount, 2)}</p>
      <p className="mt-1 text-sm text-muted-foreground">This keeps your vault on NEAR. You get it back when you close your vault.</p>
    </div>
  );
}

function Steps({ current }: { current: CreateStep }) {
  const at = CREATE_STEPS.findIndex(([s]) => s === current);
  return (
    <ul className="space-y-2 text-sm" aria-live="polite">
      {CREATE_STEPS.map(([step, label], i) => {
        const done = i < at || current === "ready";
        return (
          <li key={step} className="flex items-center gap-2">
            {done ? <Check className="size-4 text-safe" aria-hidden /> : i === at ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden /> : <span className="size-4" aria-hidden />}
            <span className={done || i === at ? undefined : "text-muted-foreground"}>{label}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * After the wallet answers (or after a redirect wallet brings the user back), confirm on chain that the account
 * exists with Backstop's setup key, then register it with the vault service. `near.create_account` "succeeds"
 * even when the name was taken (it refunds and returns false), so the chain is the only proof.
 */
function usePendingCreate(owner: string | null) {
  const [raw, setRaw] = useLocalString(owner ? pendingKey(owner) : null);
  const pending = useMemo(() => parsePending(raw), [raw]);
  const queryClient = useQueryClient();
  const [notCreated, setNotCreated] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const clearPending = useEffectEvent(() => setRaw(null));

  useEffect(() => {
    if (!pending || !PUBLIC_ENV.vaultDeployerPk) return;
    const pk = PUBLIC_ENV.vaultDeployerPk;
    let stopped = false;
    const { startedAt, ...body } = pending;
    const tick = async () => {
      if (stopped) return;
      try {
        if (await hasFullAccessKey(body.vaultId, pk)) {
          await submitRequest(body);
          if (stopped) return;
          setProblem(null);
          clearPending();
          void queryClient.invalidateQueries({ queryKey: ["vault-requests"] });
          return;
        }
        if (Date.now() - startedAt > ACCOUNT_WAIT_MS) {
          setNotCreated(true);
          clearPending();
          return;
        }
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
      }
      if (!stopped) setTimeout(() => void tick(), ACCOUNT_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
    };
  }, [pending, queryClient]);

  return {
    pending,
    notCreated,
    problem,
    remember: (p: PendingCreate) => {
      setNotCreated(false);
      setRaw(JSON.stringify(p));
    },
    dismiss: () => setNotCreated(false),
    /** The wallet rejected: nothing was sent, so there is nothing to look for. */
    forget: () => setRaw(null),
  };
}

/** "Create my Rescue vault": pick the chain, name the loan, set three limits, review once, then watch setup finish. */
export function CreateVault() {
  const { owner, known, requests, choose, openReview } = usePolicyContext();
  const { identity } = useEvmIdentity();
  const account = useNearAccount(owner);
  const [chainKey, setChainKey] = useState<string>(LOAN_CHAINS[0]!.key);
  const [typed, setTyped] = useState<string | null>(null);
  const [fields, setFields] = useState<CreateFields>(DEFAULT_FIELDS);
  const created = usePendingCreate(owner);
  const wallet = identity.mode === "none" ? "" : identity.address;
  const loanAddress = typed ?? wallet;
  const chain = LOAN_CHAINS.find((c) => c.key === chainKey) ?? LOAN_CHAINS[0]!;
  const parsed = useMemo(() => parseEvmAddress(loanAddress), [loanAddress]);
  const debt = useDebt(chain, parsed.ok ? parsed.value : null);
  const deposit = createDeposit(PUBLIC_ENV.policyCodeBytes);

  const inProgress = requests?.filter((r) => r.status === "pending" || r.status === "deploying") ?? [];
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const ended = requests?.filter((r) => (r.status === "failed" || r.status === "aborted") && now - Date.parse(r.updatedAt) < ENDED_SHOWN_MS) ?? [];

  // A request this card watched turns ready: open that vault.
  const watching = useRef(new Set<string>());
  useEffect(() => {
    for (const r of requests ?? []) {
      if (r.status === "pending" || r.status === "deploying") watching.current.add(r.vaultId);
      else if (r.status === "ready" && watching.current.has(r.vaultId)) {
        watching.current.delete(r.vaultId);
        choose(r.vaultId);
        toast.success("Your vault is ready. Next, add some USDC.");
      }
    }
  }, [requests, choose]);

  const vaultCount = new Set([...known, ...inProgress.map((r) => r.vaultId)]).size;
  const inviteQuery = useInvite(owner);
  // No account connected yet: the button is disabled by !owner anyway, so do not say "checking your invite".
  const invite = owner === null ? { allowed: true, inviteOnly: false } : inviteQuery.data ?? (inviteQuery.isError ? ("error" as const) : undefined);
  const reason = createBlockReason({
    owner: owner ?? "",
    invite,
    creationOpen: creationOpen(),
    deposit,
    nearBalance: account.data ? account.data.nearBalance : null,
    loanAddress,
    debtKind: debt.data?.kind ?? null,
    chainName: chain.name,
    fields,
    vaultCount,
  });
  const nearWallet = useNear().state;
  // An account from an Ethereum wallet: say plainly that ETH or USDC cannot pay the NEAR deposit.
  const nearHint =
    reason !== null && deposit !== null && nearWallet.status === "signed-in"
      ? ethereumWalletNearHint({ walletName: nearWallet.walletName, accountId: nearWallet.accountId, needYocto: deposit + GAS_ALLOWANCE_YOCTO, haveYocto: account.data ? account.data.nearBalance : null })
      : null;

  function create() {
    if (!owner || reason !== null) return;
    // One salt per create: the review re-prepares every 15 s and must keep the same vault name.
    const createInput = { chainKey: chain.key, loanAddress, fields, salt: randomSalt() };
    void buildCreateBody(owner, createInput).then((body) => {
      if (!body.ok) return;
      openReview({
        kind: "create_vault",
        prepare: () => prepareCreateVault(owner, createInput),
        // Remembered before the wallet opens: a redirect wallet leaves this page, and the card resumes on return.
        beforeSend: () => created.remember({ ...body.value, startedAt: Date.now() }),
        onRejected: created.forget,
        onSuccess: () => toast.info("Creating your vault account. Setup finishes in about a minute."),
      });
    });
  }

  const set = (k: keyof CreateFields) => (e: { target: { value: string } }) => setFields((f) => ({ ...f, [k]: e.target.value }));
  const label = "space-y-1 text-sm";

  return (
    <StepCard title="Create my Rescue vault" description="Your vault holds the USDC Backstop uses to repay your loan. Only you can take it out.">
      {created.pending ? (
        <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
          <p className="text-sm font-medium break-all">Setting up {created.pending.vaultId}</p>
          <Steps current="creating-account" />
          {created.problem ? <p className="text-xs text-warn">{created.problem} Retrying...</p> : null}
        </div>
      ) : null}
      {created.notCreated ? (
        <div role="status" className="space-y-2 rounded-lg border border-warn/30 bg-warn/5 p-4 text-sm">
          <p className="font-medium">Your vault account was not created.</p>
          <p className="text-muted-foreground">If your wallet approved it, the name was taken and your NEAR was returned to your wallet. Nothing else happened; you can try again.</p>
          <Button size="sm" variant="outline" onClick={created.dismiss}>OK</Button>
        </div>
      ) : null}
      {inProgress.map((r) => (
        <div key={r.vaultId} className="space-y-2 rounded-lg border bg-muted/40 p-4">
          <p className="text-sm font-medium break-all">Setting up {r.vaultId}</p>
          <Steps current={stepOf(r.status) ?? "installing"} />
          <p className="text-xs text-muted-foreground">You can leave this page; setup continues and this card picks it up when you come back.</p>
        </div>
      ))}
      {ended.map((r) => (
        <div key={r.vaultId} role="status" className="space-y-1 rounded-lg border border-warn/30 bg-warn/5 p-4 text-sm">
          <p className="font-medium break-all">{r.vaultId}</p>
          <p className="text-muted-foreground">{endedText(r)}</p>
        </div>
      ))}

      <div className="space-y-2">
        <p className="text-sm font-medium">Which loan?</p>
        <div role="group" aria-label="Loan chain" className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
          {LOAN_CHAINS.map((c) => (
            <button
              key={c.key}
              type="button"
              aria-pressed={c.key === chain.key}
              onClick={() => setChainKey(c.key)}
              className={cn("inline-flex h-9 items-center rounded-md px-3 text-sm transition-colors", c.key === chain.key ? "bg-card font-medium shadow-sm ring-1 ring-border" : "hover:bg-card/60")}
            >
              <ChainBadge chain={c} className="border-transparent px-0" />
            </button>
          ))}
        </div>
      </div>

      <label className={label}>
        <span className="font-medium">Loan address on {chain.name}</span>
        <input
          value={loanAddress}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="0x..."
          spellCheck={false}
          autoComplete="off"
          inputMode="text"
          className={cn(input, "font-mono")}
        />
        <span className="block text-xs text-muted-foreground">The address that holds your Aave loan. We only read it.</span>
      </label>
      {identity.mode === "none" ? <ConnectWalletButton variant="outline" /> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <label className={label}>
          <span className="font-medium">Rescue at health</span>
          <input inputMode="decimal" value={fields.triggerHf} onChange={set("triggerHf")} autoComplete="off" className={input} />
        </label>
        <label className={label}>
          <span className="font-medium">Most per rescue (USDC)</span>
          <input inputMode="decimal" value={fields.maxPerRescue} onChange={set("maxPerRescue")} autoComplete="off" className={input} />
        </label>
        <label className={label}>
          <span className="font-medium">Most per day (USDC)</span>
          <input inputMode="decimal" value={fields.dailyCap} onChange={set("dailyCap")} autoComplete="off" className={input} />
        </label>
      </div>

      {deposit !== null ? (
        <>
          <DepositNote amount={deposit} />
          <p className="text-xs text-muted-foreground">At least {nearText(returnedOnClose(deposit), 3)} comes back when you close the vault.</p>
        </>
      ) : null}

      {reason ? (
        <p role="status" className="text-sm text-muted-foreground">
          {reason}
          {PUBLIC_ENV.inviteContact && invite !== undefined && invite !== "error" && invite.inviteOnly && !invite.allowed ? (
            <>
              {" "}Request an invite: <a href={PUBLIC_ENV.inviteContact} className="underline" rel="noopener noreferrer">{PUBLIC_ENV.inviteContact.replace(/^mailto:/i, "")}</a>
            </>
          ) : null}
        </p>
      ) : null}
      {nearHint ? <p className="text-sm text-muted-foreground">{nearHint}</p> : null}
      {getNearEnabled() && owner && deposit !== null ? <GetNear accountId={owner} needYocto={deposit + GAS_ALLOWANCE_YOCTO} nativeYocto={account.data ? account.data.nearBalance : null} /> : null}
      <Button onClick={create} disabled={reason !== null || !owner || created.pending !== null} className="w-full sm:w-auto">
        Create my Rescue vault
      </Button>
    </StepCard>
  );
}
