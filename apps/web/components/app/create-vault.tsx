"use client";

import { LOAN_CHAINS } from "@backstop/config/registry";
import { randomSalt } from "@backstop/core";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Info, Loader2 } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ConnectWalletButton } from "@/components/app/connect-steps";
import { GetNear } from "@/components/app/get-near";
import { InviteRequestCard } from "@/components/app/invite-request";
import { useEvmIdentity } from "@/components/app/evm-identity";
import { usePolicyContext } from "@/components/app/policy-context";
import { StepCard } from "@/components/app/step-card";
import { ChainBadge } from "@/components/chain-badge";
import { ChainLogo } from "@/components/landing/chain-logo";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { VaultArt } from "@/components/app/vault-art";
import { useNear } from "@/components/wallet/near-provider";
import { buildCreateBody, buildCreateLimits, createBlockReason, createDeposit, DEFAULT_FIELDS, GAS_ALLOWANCE_YOCTO, HIDDEN_LIMITS, nearText, returnedOnClose, type CreateFields, type CreateInputs } from "@/lib/create-vault";
import { debtBlockReason, noLoanYetNote } from "@/lib/debt";
import { getNearEnabled, parseSavedTopUp, savedTopUpKey } from "@/lib/get-near";
import { hasFullAccessKey } from "@/lib/near-rpc";
import { PUBLIC_ENV } from "@/lib/public-env";
import { useDebt, useInvite, useNearAccount } from "@/lib/queries";
import { prepareCreateVault } from "@/lib/review";
import { useLocalString } from "@/lib/use-client";
import { cn } from "@/lib/utils";
import { parseEvmAddress } from "@/lib/validate";
import { ethereumWalletNearHint, isEthereumNearAccount, pendingGivesUp } from "@/lib/wallet-flow";
import { CREATE_STEPS, endedText, parsePending, pendingKey, stepOf, submitRequest, type CreateStep, type PendingCreate } from "@/lib/vault-requests";

const input = "h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm transition-[border-color,box-shadow] duration-200 hover:border-foreground/30 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30";

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
    <p className="text-sm">
      <span className="font-semibold">Refundable deposit: {nearText(amount, 2)}</span>
      <span className="text-muted-foreground"> · at least {nearText(returnedOnClose(amount), 2)} comes back when you close the vault</span>
    </p>
  );
}

/**
 * "Pay with": the deposit is paid in NEAR by the owner's NEAR account. With too little NEAR, the user can fund it
 * from MetaMask or Rabby: USDC or ETH on Base is swapped into NEAR for their own account (GetNear), then they create.
 * The tab follows the facts until the user picks one: a remembered swap keeps its tab (also after a reload and once
 * it arrived), otherwise the NEAR tab while the balance loads or covers the deposit, and the wallet tab when it is short.
 */
function PayDeposit({ deposit, owner, nearBalance, balanceError }: { deposit: bigint; owner: string | null; nearBalance: bigint | null; /** The balance read is failing (it keeps retrying). */ balanceError: boolean }) {
  const need = deposit + GAS_ALLOWANCE_YOCTO;
  const enough = nearBalance !== null && nearBalance >= need;
  const evmOffered = getNearEnabled() && owner !== null;
  const [savedSwap] = useLocalString(getNearEnabled() && owner !== null ? savedTopUpKey(owner) : null);
  const [openedAt] = useState(() => Date.now());
  const swap = owner !== null && parseSavedTopUp(savedSwap, owner, openedAt) !== null;
  const [picked, setPicked] = useState<"near" | "evm" | null>(null);
  const tab = picked ?? (!evmOffered ? "near" : swap ? "evm" : enough || nearBalance === null ? "near" : "evm");
  const tabClass = (on: boolean) =>
    cn("relative z-10 inline-flex h-9 flex-1 items-center justify-center whitespace-nowrap rounded-md px-2 text-[0.8125rem] transition-colors duration-200 active:scale-[0.98] motion-reduce:active:scale-100 sm:px-3 sm:text-sm", on ? "font-medium" : "text-muted-foreground hover:text-foreground");
  const onKeys = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") setPicked("near");
    if (e.key === "ArrowRight") setPicked("evm");
  };
  return (
    <div className="space-y-3">
      <DepositNote amount={deposit} />
      {evmOffered ? (
        <div role="tablist" aria-label="Pay with" onKeyDown={onKeys} className="relative flex gap-1 rounded-lg bg-muted p-1">
          <span
            aria-hidden
            className={cn("absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-md bg-card shadow-sm ring-1 ring-border transition-transform duration-300 ease-out motion-reduce:transition-none", tab === "evm" && "translate-x-[calc(100%+0.25rem)]")}
          />
          <button type="button" role="tab" aria-selected={tab === "near"} className={tabClass(tab === "near")} onClick={() => setPicked("near")}>
            NEAR balance
          </button>
          <button type="button" role="tab" aria-selected={tab === "evm"} className={tabClass(tab === "evm")} onClick={() => setPicked("evm")}>
            MetaMask / Rabby
          </button>
        </div>
      ) : null}
      <div key={tab} role={evmOffered ? "tabpanel" : undefined} className="step-in space-y-3 break-words">
        {tab === "near" ? (
          nearBalance === null ? (
            balanceError ? (
              <p className="text-sm text-warn">Could not read your NEAR balance. Retrying...</p>
            ) : (
              <p className="shimmer rounded text-sm text-muted-foreground">Checking your NEAR balance...</p>
            )
          ) : enough ? (
            <p className="flex items-start gap-2 text-sm">
              <Check className="check-pop mt-0.5 size-4 shrink-0 text-safe" aria-hidden />
              <span>Your NEAR account has {nearText(nearBalance, 3)}. That covers the deposit.</span>
            </p>
          ) : (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                Your NEAR account has {nearText(nearBalance, 3)}; the deposit needs about {nearText(need, 3)}.
              </p>
              {evmOffered ? (
                <Button size="sm" variant="outline" onClick={() => setPicked("evm")}>
                  Pay with USDC or ETH from MetaMask or Rabby
                </Button>
              ) : null}
              {owner ? (
                <p className="text-xs">
                  {evmOffered ? "Or send" : "Send"} NEAR to <span className="break-all font-mono text-foreground">{owner}</span> from an exchange or another wallet. This page updates when it arrives.
                </p>
              ) : null}
            </div>
          )
        ) : null}
        {tab === "evm" && enough && !swap ? <p className="text-sm text-muted-foreground">Your NEAR account already has {nearText(nearBalance, 3)}, enough for the deposit. No swap needed.</p> : null}
        {tab === "evm" && getNearEnabled() && owner ? <GetNear bare accountId={owner} needYocto={need} nativeYocto={nearBalance} /> : null}
      </div>
    </div>
  );
}

type PartStatus = "open" | "done" | "attention" | "locked";

/**
 * One part of the guided create form, on a rail of numbered dots. Open: its hint and fields. Finished: one summary
 * line with "Edit". Not reached yet: only its title, dimmed. No box; the rail joins the parts.
 */
function Part({ n, title, hint, status, summary, last = false, onEdit, children }: { n: number; title: string; hint: string; status: PartStatus; /** The one-line recap shown while closed. */ summary: ReactNode; last?: boolean; onEdit: () => void; children: ReactNode }) {
  const open = status === "open";
  return (
    <section className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3" aria-label={title}>
      <div className="flex flex-col items-center" aria-hidden>
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors duration-300",
            status === "done" && "border-primary bg-primary text-primary-foreground",
            status === "open" && "dot-halo border-primary bg-primary/15 text-primary",
            status === "attention" && "border-warn text-warn",
            status === "locked" && "border-border text-muted-foreground",
          )}
        >
          {status === "done" ? <Check key="done" className="check-pop size-4" /> : n}
        </span>
        {last ? null : <span className={cn("my-1 w-0.5 flex-1 rounded-full transition-colors duration-300", status === "done" ? "bg-primary/50" : "bg-border")} />}
      </div>
      <div className={cn("min-w-0", last ? "pb-1" : "pb-6")}>
        <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className={cn("text-sm font-semibold", status === "locked" && "text-muted-foreground")}>{title}</h3>
          {open || status === "locked" ? null : (
            <>
              <p className={cn("step-in flex min-w-0 flex-1 basis-40 flex-wrap items-center gap-x-1.5 text-sm", status === "attention" ? "text-warn" : "text-muted-foreground")}>{summary}</p>
              <button type="button" onClick={onEdit} className="shrink-0 rounded text-xs underline underline-offset-4 hover:text-foreground">
                Edit
              </button>
            </>
          )}
        </div>
        <div className="collapse-grid" data-open={open ? "true" : "false"}>
          {/* Stays mounted while closed (a quote or a typed value survives "Edit" elsewhere), but out of reach of the keyboard. */}
          <div className="-mx-1 overflow-hidden px-1" inert={!open}>
            {status === "locked" ? null : (
              <div className="max-w-2xl space-y-5 pb-1 pt-2">
                <p className="text-sm text-muted-foreground">{hint}</p>
                {children}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Quick picks under a USDC field: one tap sets the field to that amount. */
function Picks({ values, current, onPick, label }: { values: readonly string[]; current: string; onPick: (v: string) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {values.map((v) => {
        const on = current.trim() === v;
        return (
          <button
            key={v}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(v)}
            className={cn(
              "inline-flex h-8 min-w-11 items-center justify-center rounded-full border px-3 text-xs tabular-nums transition-[color,background-color,border-color,transform] duration-200 active:scale-[0.96] motion-reduce:active:scale-100",
              on ? "border-primary bg-primary/15 font-medium text-foreground" : "text-muted-foreground hover:border-foreground/30 hover:text-foreground",
            )}
          >
            {v}
          </button>
        );
      })}
    </div>
  );
}

const MAX_PICKS = ["5", "10", "25", "50"] as const;
const CAP_PICKS = ["10", "25", "50", "100"] as const;
/** The slider runs from Aave's liquidation line to the health each rescue aims for; the trigger must sit strictly between. */
const HF_FLOOR = 1;
const HF_TARGET = Number(HIDDEN_LIMITS.targetHf);

/**
 * "Rescue when health falls below": a slider whose track shows what each health means. Red: liquidation (below 1.00).
 * Amber, up to the thumb: where Backstop steps in. Green: healthy. Writes the same "1.10" string the text field holds.
 */
function HealthSlider({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const n = Number(value);
  const at = Number.isFinite(n) ? Math.min(HF_TARGET, Math.max(HF_FLOOR, n)) : Number(DEFAULT_FIELDS.triggerHf);
  const frac = (at - HF_FLOOR) / (HF_TARGET - HF_FLOOR);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center">
        <span aria-hidden className="h-2 w-8 shrink-0 rounded-l-full bg-danger sm:w-12" />
        <div className="relative h-6 min-w-0 flex-1">
          <div aria-hidden className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-r-full bg-safe/45">
            {/* The thumb's centre travels between half a thumb from each end; the fill follows it. */}
            <div className="h-full bg-warn" style={{ width: `calc(0.625rem + (100% - 1.25rem) * ${frac})` }} />
          </div>
          <input
            type="range"
            aria-label="Rescue when health falls below"
            aria-valuetext={`health ${at.toFixed(2)}`}
            min={HF_FLOOR}
            max={HF_TARGET}
            step={0.01}
            value={at}
            // The ends themselves are not valid triggers: stop one step inside them.
            onChange={(e) => onChange(Math.min(HF_TARGET - 0.01, Math.max(HF_FLOOR + 0.01, Number(e.target.value))).toFixed(2))}
            className="hf-range absolute inset-0"
          />
        </div>
      </div>
      <div className="flex justify-between gap-3 pl-8 text-[0.6875rem] tabular-nums text-muted-foreground sm:pl-12">
        <span>{HF_FLOOR.toFixed(2)}</span>
        <span>{HIDDEN_LIMITS.targetHf}</span>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {[
          ["bg-danger", "Liquidation"],
          ["bg-warn", "Backstop steps in"],
          ["bg-safe/45", "Healthy"],
        ].map(([dot, text]) => (
          <li key={text} className="flex items-center gap-1.5">
            <span aria-hidden className={cn("size-2 rounded-full", dot)} />
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** An input with its unit shown inside, on the right. */
function Unit({ unit, children }: { unit: string; children: ReactNode }) {
  return (
    <span className="relative block">
      {children}
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{unit}</span>
    </span>
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
            {done ? <Check className="check-pop size-4 text-safe" aria-hidden /> : i === at ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden /> : <span className="size-4" aria-hidden />}
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
function usePendingCreate(owner: string | null, /** Runs once the new account is confirmed on chain and registered. */ confirmed?: () => void) {
  const [raw, setRaw] = useLocalString(owner ? pendingKey(owner) : null);
  const pending = useMemo(() => parsePending(raw), [raw]);
  const queryClient = useQueryClient();
  const [notCreated, setNotCreated] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** Too many failed tries in a row: the loop stopped, and "Try again" (which bumps `run`) starts it again. */
  const [stalled, setStalled] = useState(false);
  const [run, setRun] = useState(0);
  const clearPending = useEffectEvent(() => setRaw(null));
  const onConfirmed = useEffectEvent(() => confirmed?.());

  useEffect(() => {
    if (!pending || !PUBLIC_ENV.vaultDeployerPk) return;
    const pk = PUBLIC_ENV.vaultDeployerPk;
    let stopped = false;
    let failures = 0;
    const { startedAt, ...body } = pending;
    const tick = async () => {
      if (stopped) return;
      try {
        if (await hasFullAccessKey(body.vaultId, pk)) {
          await submitRequest(body);
          if (stopped) return;
          setProblem(null);
          clearPending();
          onConfirmed();
          void queryClient.invalidateQueries({ queryKey: ["vault-requests"] });
          return;
        }
        failures = 0;
        if (Date.now() - startedAt > ACCOUNT_WAIT_MS) {
          setNotCreated(true);
          clearPending();
          return;
        }
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
        failures += 1;
        if (pendingGivesUp(failures)) {
          setStalled(true);
          return;
        }
      }
      if (!stopped) setTimeout(() => void tick(), ACCOUNT_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
    };
  }, [pending, queryClient, run]);

  return {
    pending,
    notCreated,
    problem,
    stalled,
    retry: () => {
      setStalled(false);
      setProblem(null);
      setRun((r) => r + 1);
    },
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
  /** The address is being typed by hand (the fallback); otherwise it comes from a wallet with one click. */
  const [manual, setManual] = useState(false);
  const [fields, setFields] = useState<CreateFields>(DEFAULT_FIELDS);
  // The guided sequence (presentation only): which part is open, and how far the user has got. A swap that is
  // under way (also after a reload) goes straight to the deposit part, where it lives.
  const [swapRecord, setSwapRecord] = useLocalString(getNearEnabled() && owner !== null ? savedTopUpKey(owner) : null);
  // The vault account exists, so the deposit was paid: a swap that funded it is finished and is not shown again.
  const created = usePendingCreate(owner, () => setSwapRecord(null));
  const [pickedPart, setPickedPart] = useState<1 | 2 | 3 | null>(null);
  const [reachedPart, setReachedPart] = useState<1 | 2 | 3>(1);
  const reached = swapRecord !== null ? 3 : reachedPart;
  const openPart = pickedPart ?? (swapRecord !== null ? 3 : 1);
  const goTo = (n: 1 | 2 | 3) => {
    setPickedPart(n);
    setReachedPart((r) => (n > r ? n : r));
  };
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
  const nearBalance = account.data ? account.data.nearBalance : null;
  const inputs: CreateInputs = {
    owner: owner ?? "",
    invite,
    creationOpen: creationOpen(),
    deposit,
    nearBalance,
    loanAddress,
    debtKind: debt.data?.kind ?? null,
    chainName: chain.name,
    fields,
    vaultCount,
  };
  const reason = createBlockReason(inputs);
  // What to say next to the disabled button. The button itself only ever follows `reason`.
  const need = deposit === null ? null : deposit + GAS_ALLOWANCE_YOCTO;
  const onlyShortOfNear = reason !== null && createBlockReason({ ...inputs, nearBalance: null }) === null;
  const waitingOnLoan = reason !== null && debt.data === undefined && createBlockReason({ ...inputs, debtKind: "none" }) !== reason;
  const loanReadFailed = waitingOnLoan && debt.isError;
  const checking = reason !== null && (invite === undefined || (waitingOnLoan && !debt.isError));
  const blockText =
    reason === null
      ? null
      : loanReadFailed
        ? `Could not read Aave on ${chain.name} just now.`
        : onlyShortOfNear && need !== null
          ? `Almost there: pay the deposit above. Your NEAR account needs about ${nearText(need, 2)}.`
          : reason;
  const retry = loanReadFailed ? () => void debt.refetch() : invite === "error" ? () => void inviteQuery.refetch() : null;
  const limits = useMemo(() => buildCreateLimits(fields), [fields]);
  const nearWallet = useNear().state;
  // An account from an Ethereum wallet, where swapping is not offered: say plainly that ETH or USDC cannot pay the NEAR deposit.
  const nearHint =
    reason !== null && deposit !== null && !getNearEnabled() && nearWallet.status === "signed-in"
      ? ethereumWalletNearHint({ walletName: nearWallet.walletName, accountId: nearWallet.accountId, needYocto: deposit + GAS_ALLOWANCE_YOCTO, haveYocto: nearBalance })
      : null;
  // While a vault is being set up the form steps aside: the only thing to do is wait.
  const settingUp = created.pending !== null || inProgress.length > 0;

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
  const addressBad = !parsed.ok && loanAddress.trim() !== "";
  // A NEAR account that IS an Ethereum address (from an Ethereum wallet): its loan is often on that same address.
  const nearAddress = owner !== null && nearWallet.status === "signed-in" && isEthereumNearAccount(nearWallet.walletName, owner) && parseEvmAddress(owner).ok ? owner : null;
  const sameAsNear = nearAddress !== null && loanAddress.trim().toLowerCase() === nearAddress.toLowerCase();
  const addressSource = typed === null ? (identity.mode === "wallet" ? identity.walletName : "Read-only address") : sameAsNear ? "Same as your NEAR wallet" : "Loan address";
  const notInvited = owner !== null && invite !== undefined && invite !== "error" && invite.inviteOnly && !invite.allowed;
  const textLink = "rounded text-xs underline underline-offset-4 hover:text-foreground";
  // The connected wallet becomes the loan address, whatever was typed before.
  const adoptWallet = () => {
    setTyped(null);
    setManual(false);
  };
  // A part is finished when its own existing check passes; the Create button still only follows `reason`.
  const loanDone = parsed.ok && debt.data !== undefined && debtBlockReason(debt.data.kind) === null;
  const depositCovered = need !== null && nearBalance !== null && nearBalance >= need;
  const partStatus = (n: 1 | 2 | 3, ok: boolean): PartStatus => (openPart === n ? "open" : reached < n ? "locked" : ok ? "done" : "attention");

  return (
    <StepCard
      title={settingUp ? "Setting up your vault" : "Create vault"}
      description={settingUp ? "Nothing more to do here. Step 3, adding USDC, opens when setup finishes." : "Your vault holds the USDC that repays your loan. Only you can withdraw from it."}
      art={<VaultArt className="h-20 w-28 shrink-0 sm:h-24 sm:w-32" />}
    >
      {created.pending ? (
        <div className="step-in space-y-2 rounded-lg border bg-muted/40 p-4">
          <p className="text-sm font-medium break-all">Setting up {created.pending.vaultId}</p>
          <Steps current="creating-account" />
          {created.stalled ? (
            <div role="alert" className="space-y-2 text-xs text-warn">
              <p>{created.problem} We stopped retrying. Nothing else was sent. Check your connection, then try again.</p>
              <Button size="sm" variant="outline" onClick={created.retry}>
                Try again
              </Button>
            </div>
          ) : created.problem ? (
            <p className="text-xs text-warn">{created.problem} Retrying...</p>
          ) : (
            <p className="text-xs text-muted-foreground">Keep this tab open while your new account is confirmed. It takes a few seconds.</p>
          )}
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
        <div key={r.vaultId} className="step-in space-y-2 rounded-lg border bg-muted/40 p-4">
          <p className="text-sm font-medium break-all">Setting up {r.vaultId}</p>
          <Steps current={stepOf(r.status) ?? "installing"} />
          <p className="text-xs text-muted-foreground">About a minute. Safe to leave this page; it picks up where it was when you come back.</p>
        </div>
      ))}
      {ended.map((r) => (
        <div key={r.vaultId} role="status" className="space-y-1 rounded-lg border border-warn/30 bg-warn/5 p-4 text-sm">
          <p className="font-medium break-all">{r.vaultId}</p>
          <p className="text-muted-foreground">{endedText(r)}</p>
        </div>
      ))}

      {settingUp ? null : notInvited ? (
        <InviteRequestCard key={owner} owner={owner} />
      ) : (
        <div className="space-y-6">
          {/* Where things live: the vault is on NEAR, the loan stays on its own chain. */}
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
              <ChainLogo chain="near" className="h-4" /> Your vault on NEAR
            </span>
            <ArrowRight className="size-3.5" aria-hidden />
            <span>repays your Aave loan on</span>
            <span key={chain.key} className="step-in inline-flex items-center gap-1.5 font-medium text-foreground">
              <ChainLogo chain={chain.key} className="h-4" /> {chain.name}
            </span>
          </p>

          <div>
            <Part
              n={1}
              title="Your loan"
              hint="Tell us where your Aave loan lives. We only read it."
              status={partStatus(1, loanDone)}
              onEdit={() => goTo(1)}
              summary={
                loanDone && parsed.ok ? (
                  <>
                    <ChainLogo chain={chain.key} className="h-3.5" />
                    <span>
                      {debt.data?.kind === "usdc" ? "USDC loan" : "No loan yet"} on {chain.name}
                    </span>
                    <span aria-hidden>·</span>
                    <code className="whitespace-nowrap font-mono" title={parsed.value}>
                      {parsed.value.slice(0, 6)}...{parsed.value.slice(-4)}
                    </code>
                  </>
                ) : (
                  "Needs a look before you can create."
                )
              }
            >
              <div className="space-y-2">
                <p className="text-sm font-medium">Loan chain</p>
                <div role="group" aria-label="Loan chain" className="inline-flex flex-wrap gap-1 rounded-lg bg-muted p-1">
                  {LOAN_CHAINS.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      aria-pressed={c.key === chain.key}
                      onClick={() => setChainKey(c.key)}
                      className={cn("inline-flex h-10 items-center rounded-md px-3.5 text-sm transition-[color,background-color,box-shadow,transform] active:scale-[0.97] motion-reduce:active:scale-100", c.key === chain.key ? "bg-card font-medium shadow-sm ring-1 ring-primary/60" : "hover:bg-card/60")}
                    >
                      <ChainBadge chain={c} className="border-transparent px-0 text-sm" />
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Loan wallet</p>
                {manual ? (
                  <div className="step-in space-y-2">
                    <label className="block space-y-1 text-sm">
                      <span className="sr-only">Aave loan address</span>
                      <input
                        value={loanAddress}
                        onChange={(e) => setTyped(e.target.value)}
                        placeholder="0x..."
                        spellCheck={false}
                        autoComplete="off"
                        inputMode="text"
                        aria-invalid={addressBad}
                        className={cn(input, "font-mono", addressBad && "border-danger/60 focus:border-danger focus:ring-danger/30")}
                      />
                      <span className="block text-xs text-muted-foreground">The address that borrowed on Aave. Read only: we never move funds from it.</span>
                    </label>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {wallet !== "" ? (
                        <button type="button" className={textLink} onClick={adoptWallet}>
                          Use my connected wallet
                        </button>
                      ) : (
                        <ConnectWalletButton variant="outline" label="Connect MetaMask or Rabby instead" onConnected={adoptWallet} />
                      )}
                      {nearAddress !== null && !sameAsNear ? (
                        <button
                          type="button"
                          className={textLink}
                          onClick={() => {
                            setTyped(nearAddress);
                            setManual(false);
                          }}
                        >
                          Same as my NEAR wallet
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : parsed.ok ? (
                  <div className="step-in flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-safe-bg px-3 py-2.5 text-sm">
                    <Check className="check-pop size-4 shrink-0 text-safe" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{addressSource}</span>{" "}
                      <code className="whitespace-nowrap font-mono text-muted-foreground" title={parsed.value}>
                        {parsed.value.slice(0, 6)}...{parsed.value.slice(-4)}
                      </code>
                    </span>
                    <button type="button" className={cn(textLink, "shrink-0")} onClick={() => setManual(true)}>
                      Use a different address
                    </button>
                  </div>
                ) : (
                  <div className="step-in space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <ConnectWalletButton label="Connect MetaMask or Rabby" onConnected={adoptWallet} />
                      {nearAddress !== null ? (
                        <Button variant="outline" onClick={() => setTyped(nearAddress)}>
                          Same as my NEAR wallet
                        </Button>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Read only: we look up the loan and never move funds from this wallet.{" "}
                      <button type="button" className={textLink} onClick={() => setManual(true)}>
                        Type the address instead
                      </button>
                    </p>
                  </div>
                )}
                <div aria-live="polite" className="text-xs">
                  {!parsed.ok ? (
                    addressBad ? <p className="text-danger">{parsed.error}</p> : null
                  ) : debt.data ? (
                    debt.data.kind === "usdc" ? (
                      <p className="flex items-center gap-1.5 text-foreground">
                        <Check className="check-pop size-3.5 shrink-0 text-safe" aria-hidden />
                        USDC loan found on {chain.name}.
                      </p>
                    ) : debt.data.kind === "none" ? (
                      <p className="text-muted-foreground">{noLoanYetNote(chain.name)}</p>
                    ) : (
                      <p className="text-danger">{debtBlockReason(debt.data.kind)}</p>
                    )
                  ) : debt.isError ? (
                    <p className="text-warn">
                      Could not read Aave on {chain.name}.{" "}
                      <button type="button" className="underline underline-offset-4" onClick={() => void debt.refetch()}>
                        Try again
                      </button>
                    </p>
                  ) : (
                    <p className="shimmer inline-block rounded text-muted-foreground">Looking for your loan on {chain.name}...</p>
                  )}
                </div>
              </div>

              <Button onClick={() => goTo(2)} disabled={!loanDone}>
                Continue <ArrowRight aria-hidden />
              </Button>
            </Part>

            <Part
              n={2}
              title="Safety limits"
              hint="Rescues stay within these limits, which your vault enforces. You can change them later."
              status={partStatus(2, limits.ok)}
              onEdit={() => goTo(2)}
              summary={limits.ok ? `Below ${fields.triggerHf.trim()} · up to ${fields.maxPerRescue.trim()} USDC per rescue · ${fields.dailyCap.trim()} USDC a day` : "Needs a look before you can create."}
            >
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <label htmlFor="trigger-health" className="text-sm font-medium">
                    Rescue when health falls below
                  </label>
                  <input id="trigger-health" inputMode="decimal" value={fields.triggerHf} onChange={set("triggerHf")} autoComplete="off" className={cn(input, "h-9 w-20 text-center font-mono tabular-nums")} />
                </div>
                <HealthSlider value={fields.triggerHf} onChange={(v) => setFields((f) => ({ ...f, triggerHf: v }))} />
                <p className="text-xs text-muted-foreground">
                  Health is Aave&apos;s health factor. Each rescue repays enough to aim back at {HIDDEN_LIMITS.targetHf}, within the two amounts below.
                </p>
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <label htmlFor="max-per-rescue" className="block text-sm font-medium">
                    Max per rescue
                  </label>
                  <Unit unit="USDC">
                    <input id="max-per-rescue" inputMode="decimal" value={fields.maxPerRescue} onChange={set("maxPerRescue")} autoComplete="off" className={cn(input, "pr-14 tabular-nums")} />
                  </Unit>
                  <Picks label="Max per rescue, quick picks in USDC" values={MAX_PICKS} current={fields.maxPerRescue} onPick={(v) => setFields((f) => ({ ...f, maxPerRescue: v }))} />
                </div>
                <div className="space-y-2">
                  <label htmlFor="daily-cap" className="block text-sm font-medium">
                    Daily cap
                  </label>
                  <Unit unit="USDC">
                    <input id="daily-cap" inputMode="decimal" value={fields.dailyCap} onChange={set("dailyCap")} autoComplete="off" className={cn(input, "pr-14 tabular-nums")} />
                  </Unit>
                  <Picks label="Daily cap, quick picks in USDC" values={CAP_PICKS} current={fields.dailyCap} onPick={(v) => setFields((f) => ({ ...f, dailyCap: v }))} />
                </div>
              </div>

              <p aria-live="polite" className={cn("text-sm", limits.ok ? "text-muted-foreground" : "text-danger")}>
                {limits.ok
                  ? `In words: when health falls below ${fields.triggerHf.trim()}, Backstop can repay up to ${fields.maxPerRescue.trim()} USDC per rescue and at most ${fields.dailyCap.trim()} USDC a day, from your vault. You can change these later.`
                  : limits.error}
              </p>

              <Button onClick={() => goTo(3)} disabled={!limits.ok}>
                Continue <ArrowRight aria-hidden />
              </Button>
            </Part>

            {deposit !== null ? (
              <Part
                n={3}
                title="Deposit"
                hint="A refundable deposit pays for your vault's storage on NEAR. Pay it with NEAR, or with USDC or ETH from another wallet."
                status={partStatus(3, depositCovered)}
                onEdit={() => goTo(3)}
                last
                summary={
                  <>
                    <ChainLogo chain="near" className="h-3.5" />
                    <span>{depositCovered ? `${nearText(deposit, 2)} refundable deposit, covered` : `${nearText(deposit, 2)} refundable deposit, still to pay`}</span>
                  </>
                }
              >
                <PayDeposit deposit={deposit} owner={owner} nearBalance={nearBalance} balanceError={account.isError} />
              </Part>
            ) : null}
          </div>

          {reached === 3 || deposit === null ? (
            <div className="step-in space-y-3 border-t pt-5">
              {blockText ? (
                <div role="status" className="flex items-start gap-2 text-sm text-muted-foreground">
                  {checking ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden /> : <Info className="mt-0.5 size-4 shrink-0" aria-hidden />}
                  <p className="min-w-0 break-words">
                    {blockText}
                    {retry ? (
                      <>
                        {" "}
                        <button type="button" className="underline underline-offset-4 hover:text-foreground" onClick={retry}>
                          Try again
                        </button>
                      </>
                    ) : null}
                  </p>
                </div>
              ) : (
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Check className="check-pop mt-0.5 size-4 shrink-0 text-safe" aria-hidden />
                  <span>Ready. Next you review everything once, then approve in your NEAR wallet. Setup takes about a minute.</span>
                </p>
              )}
              {nearHint ? <p className="break-words text-sm text-muted-foreground">{nearHint}</p> : null}
              <Button id="create-vault-button" size="lg" onClick={create} disabled={reason !== null || !owner || created.pending !== null} className={cn("w-full scroll-mt-28 sm:w-auto", reason === null && "dot-halo")}>
                Create vault
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </StepCard>
  );
}
