/**
 * Multi-vault bot service (design v3 1.1). One pass every 30 s:
 *   discover (every 60 s) -> admit (new vaults; refused ones every 5 min; admitted ones hourly)
 *   -> one batched loan read per chain -> status row for every vault
 *   -> act: vaults below trigger, lowest health first, at most `maxConcurrent` at once, one lock per vault.
 * Acting never blocks the pass: rescues run in the background, so status rows of the other vaults
 * stay fresh. A throw in one vault is recorded on that vault only. All I/O goes through ServiceIO
 * (live wiring in service-live.ts), so the loop is tested with fakes.
 */
import { formatUsdc, twoRepaysGasWei, type Limits, type RescueDecision, type RescueRecord, type VaultReason, type VaultStatus } from "@backstop/core";
import type { VaultStatusStore } from "@backstop/db";
import type { Admission } from "./discover.js";
import type { ActivePolicyConfig } from "./policy.js";
import { belowTrigger, nearTrigger, refusedStatus, watchStatus, type LoanRead, type Outcome } from "./status.js";

export type AlertKind = "rescue_done" | "rescue_failed" | "vault_refused" | "bot_near_low" | "rpc_failing" | "discovery_failed";
export interface Alert {
  kind: AlertKind;
  text: string;
}

/** What a rescue task reports back. */
export interface TaskResult {
  decision?: RescueDecision;
  record?: RescueRecord;
}

/** An admitted vault as the service tracks it. */
export interface Vault {
  policyId: string;
  config: ActivePolicyConfig;
  limits: Limits;
  usdcVault: bigint;
}

export type TaskKind = "rescue" | "approve" | "resume";

export interface ServiceIO {
  now(): Date;
  log(line: string): void;
  /** Vault ids from ready creation requests, the factory and POLICY_CONTRACT_IDS. */
  discover(): Promise<string[]>;
  /** Works through open vault creation requests (vault-creator.ts); resolves with how many became ready. Runs in the background, one run at a time. */
  createVaults?(): Promise<number>;
  admit(policyId: string): Promise<Admission>;
  /** Fresh limits + vault USDC on NEAR. */
  readNear(policyId: string): Promise<{ limits: Limits; usdcVault: bigint }>;
  /** One batched read for every vault on a chain; a per-vault Error where only that vault failed. */
  readLoans(chainId: number, vaults: readonly Vault[]): Promise<Map<string, LoanRead | Error>>;
  /** Fee per gas and the L1 data fee of one repay on that chain. */
  chainFees(chainId: number): Promise<{ maxFeePerGas: bigint; l1Fee: bigint }>;
  /** Vault ids with a signed repay not yet broadcast (resumeSignedRepay). */
  pendingResumes(): Promise<Set<string>>;
  /** Runs one task for a vault (inside its lock). */
  runTask(kind: TaskKind, vault: Vault): Promise<TaskResult>;
  statusStore: Pick<VaultStatusStore, "upsert">;
  alert(a: Alert): Promise<void>;
  /** The bot account's NEAR balance in yoctoNEAR. */
  botBalance?(): Promise<bigint>;
  /** Dead-man's switch ping, once per pass. */
  heartbeat?(): Promise<void>;
}

export interface ServiceOptions {
  dryRun: boolean;
  intervalMs: number;
  maxConcurrent: number;
  discoverEveryMs: number;
  admitEveryMs: number;
  refusedRecheckMs: number;
  nearRefreshMs: number;
  /** After an attempt that did not succeed, wait this long before trying the vault again. */
  retryMs: number;
  /** Dry runs record a would-be rescue at most this often per vault. */
  dryRunRepeatMs: number;
  /** Proactive approve at most this often per vault (the contract allows one per hour). */
  approveEveryMs: number;
  /** Alert when the bot account holds less than this (yoctoNEAR). */
  botLowYocto: bigint;
  /** Alert after this many consecutive failed reads of one chain. */
  rpcFailAlertAfter: number;
}

export const DEFAULT_SERVICE_OPTIONS: ServiceOptions = {
  dryRun: false,
  intervalMs: 30_000,
  maxConcurrent: 6,
  discoverEveryMs: 60_000,
  admitEveryMs: 3_600_000,
  refusedRecheckMs: 300_000,
  nearRefreshMs: 300_000,
  retryMs: 60_000,
  dryRunRepeatMs: 600_000,
  approveEveryMs: 3_600_000,
  botLowYocto: 500_000_000_000_000_000_000_000n, // 0.5 NEAR
  rpcFailAlertAfter: 3,
};

interface Tracked {
  policyId: string;
  admission?: Admission;
  admittedAt: number;
  vault?: Vault;
  nearAt: number;
  lastGood?: LoanRead;
  outcome?: Outcome;
  nextActionAt: number;
  approveAt: number;
  refusedAlerted?: string;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Maps a blocked decision from the risk engine to a status reason. */
function blockedReason(reason: string): VaultReason {
  if (/paused/i.test(reason)) return "PAUSED";
  return "LIMIT_REACHED";
}

/** Runs `fn` over `items` with at most `n` in flight. */
async function eachLimited<T>(items: readonly T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]!);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

export class VaultService {
  private readonly vaults = new Map<string, Tracked>();
  /** Per-vault lock: a vault id is here while a task runs for it. */
  private readonly locked = new Set<string>();
  private readonly running = new Set<Promise<void>>();
  private readonly chainFailures = new Map<number, number>();
  private lastDiscover = Number.NEGATIVE_INFINITY;
  private passes = 0;
  /** The running vault creation run, if any: a slow deploy never delays status rows or rescues. */
  private creating = false;
  readonly opts: ServiceOptions;

  constructor(
    private readonly io: ServiceIO,
    opts: Partial<ServiceOptions> = {},
  ) {
    this.opts = { ...DEFAULT_SERVICE_OPTIONS, ...opts };
  }

  /** Waits for every task started so far (tests; graceful shutdown). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  /** One pass. Never throws: every failure is logged, alerted or written to a vault's status row. */
  async pass(): Promise<VaultStatus[]> {
    this.passes += 1;
    const now = this.io.now().getTime();
    this.startCreating();
    await this.discover(now);
    await this.admitDue(now);
    const rows: VaultStatus[] = [];
    const checkedAt = new Date(now).toISOString();
    for (const t of this.vaults.values()) {
      if (t.admission && !t.admission.ok) rows.push(refusedStatus(t.policyId, t.admission.chainId, t.admission.reason, t.admission.message, checkedAt));
    }

    const admitted = [...this.vaults.values()].filter((t): t is Tracked & { vault: Vault } => t.vault !== undefined);
    await eachLimited(
      admitted.filter((t) => now - t.nearAt >= this.opts.nearRefreshMs),
      8,
      (t) => this.refreshNear(t, now),
    );

    const byChain = new Map<number, (Tracked & { vault: Vault })[]>();
    for (const t of admitted) byChain.set(t.vault.config.chainId, [...(byChain.get(t.vault.config.chainId) ?? []), t]);
    const candidates: { t: Tracked & { vault: Vault }; hf: bigint }[] = [];
    const approvals: (Tracked & { vault: Vault })[] = [];

    await Promise.all(
      [...byChain].map(async ([chainId, list]) => {
        try {
          const [reads, fees] = await Promise.all([this.io.readLoans(chainId, list.map((t) => t.vault)), this.io.chainFees(chainId)]);
          this.chainFailures.set(chainId, 0);
          await this.chainOk(chainId, list, reads, fees, now, checkedAt, rows, candidates, approvals);
        } catch (err) {
          const n = (this.chainFailures.get(chainId) ?? 0) + 1;
          this.chainFailures.set(chainId, n);
          this.io.log(`Chain ${chainId}: read failed (${errText(err)}), ${n} pass(es) in a row.`);
          if (n === this.opts.rpcFailAlertAfter) await this.alert("rpc_failing", `Chain ${chainId} RPC failed ${n} passes in a row: ${errText(err)}`);
          const e = err instanceof Error ? err : new Error(String(err));
          for (const t of list) rows.push(this.rowFor(t, e, 0n, checkedAt));
        }
      }),
    );

    await this.startResumes(now);
    candidates.sort((a, b) => (a.hf < b.hf ? -1 : a.hf > b.hf ? 1 : 0));
    for (const { t } of candidates) this.start("rescue", t, now);
    for (const t of approvals) this.start("approve", t, now);

    // Vaults whose task started this pass are "rescuing".
    for (const r of rows) {
      if (this.locked.has(r.policyId) && r.state !== "refused" && r.reason !== "READ_FAILED") {
        r.state = "rescuing";
        r.reason = null;
        r.lastError = null;
      }
    }
    try {
      await this.io.statusStore.upsert(rows);
    } catch (err) {
      this.io.log(`Could not write vault status rows: ${errText(err)}`);
    }
    await this.housekeeping();
    return rows;
  }

  private async chainOk(
    chainId: number,
    list: (Tracked & { vault: Vault })[],
    reads: Map<string, LoanRead | Error>,
    fees: { maxFeePerGas: bigint; l1Fee: bigint },
    now: number,
    checkedAt: string,
    rows: VaultStatus[],
    candidates: { t: Tracked & { vault: Vault }; hf: bigint }[],
    approvals: (Tracked & { vault: Vault })[],
  ): Promise<void> {
    for (const t of list) {
      const read = reads.get(t.policyId) ?? new Error(`no read returned for ${t.policyId} on chain ${chainId}`);
      if (!(read instanceof Error)) {
        // Close to the trigger: re-read limits and vault USDC every pass, not every 5 minutes.
        if (t.nearAt !== now && nearTrigger(read.position, t.vault.limits.triggerHfBps)) await this.refreshNear(t, now);
        t.lastGood = read;
        if (!belowTrigger(read.position, t.vault.limits.triggerHfBps)) t.outcome = undefined;
      }
      const gasNeed = twoRepaysGasWei(t.vault.limits.maxGasLimit, fees.maxFeePerGas, t.vault.limits.maxFeePerGas, fees.l1Fee);
      const row = this.rowFor(t, read, gasNeed, checkedAt);
      rows.push(row);
      if (read instanceof Error || this.locked.has(t.policyId) || now < t.nextActionAt) continue;
      const actionable = row.readiness.debt === "usdc" && row.readiness.funds !== "empty" && row.readiness.gas !== "empty" && !t.vault.limits.paused;
      if (!actionable) continue;
      if (belowTrigger(read.position, t.vault.limits.triggerHfBps)) {
        candidates.push({ t, hf: read.position.healthFactor });
      } else if (!this.opts.dryRun && read.allowance < t.vault.limits.maxPerRescue && now >= t.approveAt) {
        approvals.push(t);
      }
    }
  }

  private rowFor(t: Tracked & { vault: Vault }, read: LoanRead | Error, gasNeedWei: bigint, checkedAt: string): VaultStatus {
    return watchStatus({
      policyId: t.policyId,
      config: t.vault.config,
      limits: t.vault.limits,
      usdcVault: t.vault.usdcVault,
      read,
      lastGood: t.lastGood,
      gasNeedWei,
      rescuing: this.locked.has(t.policyId),
      outcome: t.outcome,
      checkedAt,
    });
  }

  /** Starts one background run of vault creation unless dry-running, not configured, or one is still running. */
  private startCreating(): void {
    const create = this.io.createVaults;
    if (this.opts.dryRun || !create || this.creating) return;
    this.creating = true;
    const task = create
      .call(this.io)
      .then((ready) => {
        // A vault that just became ready is picked up by the next pass's discovery, not up to 60 s later.
        if (ready > 0) this.lastDiscover = Number.NEGATIVE_INFINITY;
      })
      .catch((err: unknown) => this.io.log(`Vault creation run failed: ${errText(err)}`))
      .finally(() => {
        this.creating = false;
      });
    this.running.add(task);
    void task.finally(() => this.running.delete(task));
  }

  private async discover(now: number): Promise<void> {
    if (now - this.lastDiscover < this.opts.discoverEveryMs) return;
    try {
      const ids = await this.io.discover();
      this.lastDiscover = now;
      for (const id of ids) {
        if (!this.vaults.has(id)) {
          this.vaults.set(id, { policyId: id, admittedAt: Number.NEGATIVE_INFINITY, nearAt: Number.NEGATIVE_INFINITY, nextActionAt: 0, approveAt: 0 });
          this.io.log(`Discovered vault ${id}.`);
        }
      }
    } catch (err) {
      this.io.log(`Discovery failed: ${errText(err)}`);
      await this.alert("discovery_failed", `Vault discovery failed: ${errText(err)}`);
    }
  }

  private async admitDue(now: number): Promise<void> {
    const due = [...this.vaults.values()].filter((t) => {
      if (this.locked.has(t.policyId)) return false;
      const every = t.admission?.ok === false ? this.opts.refusedRecheckMs : this.opts.admitEveryMs;
      return now - t.admittedAt >= every;
    });
    await eachLimited(due, 8, async (t) => {
      const a = await this.io.admit(t.policyId).catch(
        (err: unknown): Admission => ({ ok: false, policyId: t.policyId, chainId: null, reason: "UNREADABLE", message: errText(err) }),
      );
      t.admittedAt = now;
      t.admission = a;
      if (a.ok) {
        const fresh = !t.vault;
        t.vault = { policyId: t.policyId, config: a.config, limits: a.limits, usdcVault: t.vault?.usdcVault ?? 0n };
        if (fresh) {
          t.nearAt = Number.NEGATIVE_INFINITY;
          this.io.log(`Vault ${t.policyId} admitted (${a.config.chain.name}, rescue wallet ${a.config.baseAddress}).`);
        }
        t.refusedAlerted = undefined;
      } else {
        t.vault = undefined;
        t.lastGood = undefined;
        if (t.refusedAlerted !== a.reason) {
          t.refusedAlerted = a.reason;
          this.io.log(`Vault ${t.policyId} refused (${a.reason}): ${a.message}`);
          await this.alert("vault_refused", `Vault ${t.policyId} refused (${a.reason}): ${a.message}`);
        }
      }
    });
    // Two vaults must never share a rescue wallet (its nonce and balance would be shared).
    const seen = new Map<string, string>();
    for (const t of this.vaults.values()) {
      if (!t.vault) continue;
      const key = `${t.vault.config.chainId}:${t.vault.config.baseAddress.toLowerCase()}`;
      const other = seen.get(key);
      if (other === undefined) {
        seen.set(key, t.policyId);
        continue;
      }
      t.admission = {
        ok: false,
        policyId: t.policyId,
        chainId: t.vault.config.chainId,
        reason: "DUPLICATE_RESCUE_WALLET",
        message: `rescue wallet ${t.vault.config.baseAddress} is also used by ${other}`,
      };
      t.vault = undefined;
    }
  }

  private async refreshNear(t: Tracked, now: number): Promise<void> {
    if (!t.vault) return;
    try {
      const { limits, usdcVault } = await this.io.readNear(t.policyId);
      t.vault = { ...t.vault, limits, usdcVault };
      t.nearAt = now;
    } catch (err) {
      this.io.log(`Vault ${t.policyId}: NEAR read failed (${errText(err)}); using the last known limits.`);
    }
  }

  private async startResumes(now: number): Promise<void> {
    if (this.opts.dryRun) return;
    let ids: Set<string>;
    try {
      ids = await this.io.pendingResumes();
    } catch (err) {
      this.io.log(`Could not list rescues to resume: ${errText(err)}`);
      return;
    }
    for (const id of ids) {
      const t = this.vaults.get(id);
      if (t?.vault) this.start("resume", t as Tracked & { vault: Vault }, now);
    }
  }

  /** Starts a task unless the vault is locked or every slot is taken. */
  private start(kind: TaskKind, t: Tracked & { vault: Vault }, now: number): void {
    if (this.locked.has(t.policyId) || this.locked.size >= this.opts.maxConcurrent) return;
    this.locked.add(t.policyId);
    if (kind === "approve") t.approveAt = now + this.opts.approveEveryMs;
    const vault = t.vault;
    const task = (async () => {
      try {
        const res = await this.io.runTask(kind, vault);
        this.afterTask(kind, t, res, now);
      } catch (err) {
        t.outcome = { reason: "RESCUE_FAILED", message: errText(err) };
        t.nextActionAt = now + this.opts.retryMs;
        this.io.log(`Vault ${t.policyId}: ${kind} failed: ${errText(err)}`);
        if (kind !== "approve") await this.alert("rescue_failed", `Rescue of ${t.policyId} failed: ${errText(err)}`);
      } finally {
        this.locked.delete(t.policyId);
      }
    })();
    this.running.add(task);
    void task.finally(() => this.running.delete(task));
  }

  private afterTask(kind: TaskKind, t: Tracked, res: TaskResult, now: number): void {
    if (kind === "approve") return;
    const rec = res.record;
    if (rec?.status === "success") {
      t.outcome = undefined;
      t.nextActionAt = 0;
      void this.alert("rescue_done", `Rescued ${t.policyId}: repaid ${formatUsdc(BigInt(rec.amount))} USDC, HF ${rec.hfBefore.toFixed(4)} -> ${rec.hfAfter?.toFixed(4) ?? "?"}. ${rec.links.baseRepayTx ?? ""}`.trim());
      return;
    }
    if (rec?.status === "dry-run") {
      t.nextActionAt = now + this.opts.dryRunRepeatMs;
      return;
    }
    if (rec?.status === "failed") {
      t.outcome = { reason: "RESCUE_FAILED", message: rec.error ?? "rescue failed" };
      t.nextActionAt = now + this.opts.retryMs;
      void this.alert("rescue_failed", `Rescue of ${t.policyId} failed: ${rec.error ?? "unknown error"}`);
      return;
    }
    if (res.decision?.action === "blocked") {
      t.outcome = { reason: blockedReason(res.decision.reason), message: res.decision.reason };
      t.nextActionAt = now + this.opts.retryMs;
    }
  }

  private async housekeeping(): Promise<void> {
    if (this.io.heartbeat) await this.io.heartbeat().catch((err: unknown) => this.io.log(`Heartbeat failed: ${errText(err)}`));
    if (this.io.botBalance && this.passes % 10 === 1) {
      try {
        const bal = await this.io.botBalance();
        if (bal < this.opts.botLowYocto) await this.alert("bot_near_low", `Bot NEAR balance is low: ${(Number(bal / 10n ** 21n) / 1000).toFixed(3)} NEAR. Top it up.`);
      } catch (err) {
        this.io.log(`Could not read the bot balance: ${errText(err)}`);
      }
    }
  }

  private async alert(kind: AlertKind, text: string): Promise<void> {
    await this.io.alert({ kind, text }).catch((err: unknown) => this.io.log(`Alert webhook failed: ${errText(err)}`));
  }

  /** Runs passes every `intervalMs` until `stop()` resolves true. */
  async run(shouldStop: () => boolean): Promise<void> {
    while (!shouldStop()) {
      const started = Date.now();
      await this.pass();
      const wait = Math.max(0, this.opts.intervalMs - (Date.now() - started));
      if (!shouldStop()) await new Promise((r) => setTimeout(r, wait));
    }
    await this.idle();
  }
}
