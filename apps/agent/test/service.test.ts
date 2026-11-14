import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { AAVE_ARBITRUM, ARBITRUM, ONE_CLICK, loanChainById } from "@backstop/config";
import type { Limits, PolicyStatus, VaultStatus } from "@backstop/core";
import { admitVault, discoverVaults, type AdmitIO, type Admission, type ViewFn } from "../src/discover.js";
import { NearSubmitQueue, type NearCall, type NearKeyClient } from "../src/near-queue.js";
import type { ActivePolicyConfig, PolicyConfig } from "../src/policy.js";
import { VaultService, type ServiceIO, type TaskKind, type Vault } from "../src/service.js";
import type { LoanRead } from "../src/status.js";
import { BASE_ADDRESS, config as baseConfig, limits, position, status } from "./helpers.js";

const BOT = "agent.near";
const WALLET_B: Address = getAddress("0x00000000000000000000000000000000000000B2");
const arbConfig: ActivePolicyConfig = {
  ...baseConfig,
  chainId: ARBITRUM.chainId,
  chain: loanChainById(ARBITRUM.chainId),
  aavePool: AAVE_ARBITRUM.pool,
  usdcBase: AAVE_ARBITRUM.usdc,
  bridgeDestAsset: ONE_CLICK.expectedUsdcArbitrumAssetId,
  baseAddress: WALLET_B,
};

/** debtUsd8 sets HF = 16 / debt (helpers.position); usdcDebt 0 with debt = non-USDC debt. */
const loan = (debtUsd8: bigint, over: Partial<LoanRead> = {}): LoanRead => ({
  position: position(debtUsd8),
  usdcDebt: debtUsd8 / 100n,
  walletUsdc: 0n,
  allowance: 10n ** 30n,
  gasWei: 10n ** 16n,
  ...over,
});

interface Fixture {
  id: string;
  config: ActivePolicyConfig;
  read: LoanRead | Error;
  admission?: Admission;
}

function fakeIO(fixtures: Fixture[], over: Partial<ServiceIO> = {}) {
  const calls: { task: { kind: TaskKind; id: string }[]; rows: VaultStatus[][]; admit: string[]; alerts: string[] } = {
    task: [],
    rows: [],
    admit: [],
    alerts: [],
  };
  let t = Date.parse("2026-11-14T12:00:00Z");
  const io: ServiceIO = {
    now: () => new Date(t),
    log: () => {},
    discover: async () => fixtures.map((f) => f.id),
    admit: async (id) => {
      calls.admit.push(id);
      const f = fixtures.find((x) => x.id === id)!;
      return f.admission ?? { ok: true, policyId: id, config: f.config, limits };
    },
    readNear: async () => ({ limits, usdcVault: 20_000_000n }),
    readLoans: async (_chainId, vaults: readonly Vault[]) =>
      new Map(vaults.map((v) => [v.policyId, fixtures.find((x) => x.id === v.policyId)!.read])),
    chainFees: async () => ({ maxFeePerGas: 1_000_000n, l1Fee: 0n }),
    pendingResumes: async () => new Set(),
    runTask: async (kind, v) => {
      calls.task.push({ kind, id: v.policyId });
      return {};
    },
    statusStore: { upsert: async (rows) => void calls.rows.push([...rows]) },
    alert: async (a) => void calls.alerts.push(a.kind),
    ...over,
  };
  return { io, calls, tick: (ms: number) => (t += ms) };
}

const HEALTHY = 10_00000000n; // HF 1.6
const LOW = 15_00000000n; // HF ~1.07 (< trigger 1.10)

describe("bot service", () => {
  it("service_rescues_only_the_vault_below_trigger", async () => {
    const { io, calls } = fakeIO([
      { id: "base-1.vaults.near", config: baseConfig, read: loan(HEALTHY) },
      { id: "arbitrum-2.vaults.near", config: arbConfig, read: loan(LOW) },
    ]);
    const svc = new VaultService(io);
    const rows = await svc.pass();
    await svc.idle();
    expect(calls.task).toEqual([{ kind: "rescue", id: "arbitrum-2.vaults.near" }]);
    expect(rows.map((r) => [r.policyId, r.chainId, r.state]).sort()).toEqual([
      ["arbitrum-2.vaults.near", ARBITRUM.chainId, "rescuing"],
      ["base-1.vaults.near", 8453, "watching"],
    ]);
  });

  it("status_row_is_written_every_pass", async () => {
    const { io, calls, tick } = fakeIO([
      { id: "base-1.vaults.near", config: baseConfig, read: loan(HEALTHY) },
      { id: "arbitrum-2.vaults.near", config: arbConfig, read: loan(HEALTHY) },
    ]);
    const svc = new VaultService(io);
    for (let i = 0; i < 3; i++) {
      await svc.pass();
      tick(30_000);
    }
    expect(calls.rows).toHaveLength(3);
    for (const pass of calls.rows) expect(pass.map((r) => r.policyId).sort()).toEqual(["arbitrum-2.vaults.near", "base-1.vaults.near"]);
    expect(new Set(calls.rows.map((p) => p[0]!.checkedAt)).size).toBe(3);
    expect(calls.rows[0]![0]).toMatchObject({ hf: "1600000000000000000", readiness: { funds: "ok", gas: "ok", debt: "usdc" } });
  });

  it("refused_vault_is_never_called", async () => {
    const refused = (reason: "HAS_ACCESS_KEYS" | "AGENT_MISMATCH"): Admission => ({ ok: false, policyId: reason, chainId: 8453, reason, message: reason });
    const { io, calls } = fakeIO([
      { id: "keyed.near", config: baseConfig, read: loan(LOW), admission: refused("HAS_ACCESS_KEYS") },
      { id: "other-agent.near", config: baseConfig, read: loan(LOW), admission: refused("AGENT_MISMATCH") },
    ]);
    let loanReads = 0;
    io.readLoans = async () => {
      loanReads += 1;
      return new Map();
    };
    const svc = new VaultService(io);
    const rows = await svc.pass();
    await svc.idle();
    expect(calls.task).toEqual([]);
    expect(loanReads).toBe(0);
    expect(rows.map((r) => [r.policyId, r.state, r.reason])).toEqual([
      ["keyed.near", "refused", "HAS_ACCESS_KEYS"],
      ["other-agent.near", "refused", "AGENT_MISMATCH"],
    ]);
    expect(calls.alerts.filter((a) => a === "vault_refused")).toHaveLength(2);
  });

  it("one_failing_vault_does_not_block_others", async () => {
    const { io, calls } = fakeIO([
      { id: "broken.near", config: baseConfig, read: new Error("execution reverted") },
      { id: "throws.near", config: { ...arbConfig, baseAddress: getAddress("0x00000000000000000000000000000000000000C3") }, read: loan(LOW + 1n) },
      { id: "ok.near", config: arbConfig, read: loan(LOW) },
    ]);
    const run = io.runTask;
    io.runTask = async (kind, v) => {
      if (v.policyId === "throws.near") throw new Error("boom");
      return run(kind, v);
    };
    const svc = new VaultService(io);
    const rows = await svc.pass();
    await svc.idle();
    expect(calls.task).toEqual([{ kind: "rescue", id: "ok.near" }]);
    expect(rows.find((r) => r.policyId === "broken.near")).toMatchObject({ state: "blocked", reason: "READ_FAILED" });
    const next = await svc.pass();
    expect(next.find((r) => r.policyId === "throws.near")).toMatchObject({ state: "blocked", reason: "RESCUE_FAILED", lastError: "boom" });
    await svc.idle();
    // the healthy-path vault keeps being served; the failed one waits retryMs before another try
    expect(calls.task.map((t) => t.id)).toEqual(["ok.near", "ok.near"]);
  });

  it("lowest_health_is_served_first", async () => {
    const w = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
    const { io, calls } = fakeIO([
      { id: "a.near", config: { ...baseConfig, baseAddress: w(1) }, read: loan(15_00000000n) },
      { id: "b.near", config: { ...baseConfig, baseAddress: w(2) }, read: loan(15_90000000n) },
      { id: "c.near", config: { ...baseConfig, baseAddress: w(3) }, read: loan(15_50000000n) },
    ]);
    const svc = new VaultService(io, { maxConcurrent: 2 });
    await svc.pass();
    await svc.idle();
    expect(calls.task.map((t) => t.id)).toEqual(["b.near", "c.near"]);
  });

  it("debt_that_is_not_usdc_is_flagged_and_never_rescued", async () => {
    const { io, calls } = fakeIO([{ id: "weth-debt.near", config: baseConfig, read: loan(LOW, { usdcDebt: 0n }) }]);
    const svc = new VaultService(io);
    const [row] = await svc.pass();
    await svc.idle();
    expect(calls.task).toEqual([]);
    expect(row).toMatchObject({ state: "blocked", reason: "DEBT_NOT_USDC", readiness: { debt: "other" } });
  });

  it("a_vault_is_never_acted_on_twice_at_once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { io, calls, tick } = fakeIO([{ id: "a.near", config: baseConfig, read: loan(LOW) }]);
    io.runTask = async (kind, v) => {
      calls.task.push({ kind, id: v.policyId });
      await gate;
      return {};
    };
    const svc = new VaultService(io);
    await svc.pass();
    tick(30_000);
    const [row] = await svc.pass();
    expect(row!.state).toBe("rescuing");
    expect(calls.task).toHaveLength(1);
    release();
    await svc.idle();
  });

  it("two_vaults_sharing_a_rescue_wallet_are_not_both_admitted", async () => {
    const { io } = fakeIO([
      { id: "a.near", config: baseConfig, read: loan(HEALTHY) },
      { id: "b.near", config: { ...baseConfig, baseAddress: BASE_ADDRESS }, read: loan(HEALTHY) },
    ]);
    const rows = await new VaultService(io).pass();
    expect(rows.find((r) => r.policyId === "b.near")).toMatchObject({ state: "refused", reason: "DUPLICATE_RESCUE_WALLET" });
  });
});

describe("admission", () => {
  const policy: PolicyConfig = { ...baseConfig, agent: BOT };
  const io = (over: Partial<AdmitIO & { keys: number; agent: string; hash: string }> = {}): AdmitIO => ({
    readPolicy: async () => ({ config: { ...policy, agent: over.agent ?? BOT }, limits: limits as Limits, status: status as PolicyStatus }),
    accessKeyCount: async () => over.keys ?? 0,
    codeHashHex: async () => over.hash ?? "ab".repeat(32),
    derive: async () => ({ chainsig: BASE_ADDRESS, mpcView: BASE_ADDRESS }),
  });
  const expect_ = { botAccountId: BOT, codeHash: "ab".repeat(32) };

  it("admits_a_keyless_vault_of_this_bot_with_the_factory_code", async () => {
    expect((await admitVault(io(), "v.near", expect_)).ok).toBe(true);
  });
  it("refuses_keyed_foreign_agent_and_wrong_code_vaults_with_a_reason", async () => {
    const r = async (o: Parameters<typeof io>[0]) => {
      const a = await admitVault(io(o), "v.near", expect_);
      return a.ok ? "ok" : a.reason;
    };
    expect(await r({ keys: 1 })).toBe("HAS_ACCESS_KEYS");
    expect(await r({ agent: "someone.near" })).toBe("AGENT_MISMATCH");
    expect(await r({ hash: "cd".repeat(32) })).toBe("CODE_HASH_MISMATCH");
    const unreadable = await admitVault({ ...io(), readPolicy: async () => Promise.reject(new Error("no account")) }, "v.near", expect_);
    expect(unreadable).toMatchObject({ ok: false, reason: "UNREADABLE" });
  });
});

describe("discovery", () => {
  it("pages_list_policies_up_to_policy_count_and_adds_operator_vaults", async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ policy: `base-${i}.f.near`, owner: "o.near", chain: "base" }));
    const asked: unknown[] = [];
    const view: ViewFn = async (_id, method, args) => {
      if (method === "policy_count") return String(all.length);
      asked.push(args);
      const { from_index, limit } = args as { from_index: number; limit: number };
      return all.slice(from_index, from_index + limit);
    };
    const { listFactoryVaults } = await import("../src/discover.js");
    expect((await listFactoryVaults(view, "f.near", 2)).map((e) => e.policy)).toEqual(all.map((e) => e.policy));
    expect(asked).toEqual([{ from_index: 0, limit: 2 }, { from_index: 2, limit: 2 }, { from_index: 4, limit: 2 }]);
    const ids = await discoverVaults(view, { factoryId: "f.near", policyIds: ["base-0.f.near", "op.near"] });
    expect(ids).toEqual([...all.map((e) => e.policy), "op.near"]);
  });
});

describe("NEAR submit queue", () => {
  function fakeKey(chainNonce = 100n, failFirst = false) {
    const used: bigint[] = [];
    let chain = chainNonce;
    let failed = !failFirst;
    const key: NearKeyClient = {
      chainNonce: async () => chain,
      submit: async (nonce: bigint, _call: NearCall) => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        if (!failed) {
          failed = true;
          chain = 150n; // the key was used elsewhere
          throw new Error("InvalidNonce: tx nonce 101 must be larger than 150");
        }
        if (nonce <= chain || used.includes(nonce)) throw new Error(`InvalidNonce ${nonce}`);
        used.push(nonce);
        return `tx${nonce}`;
      },
      result: async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 20));
        return null;
      },
    };
    return { key, used };
  }
  const call: NearCall = { receiverId: "v.near", methodName: "rescue", args: {}, tgas: 300 };

  it("near_sends_never_reuse_a_nonce", async () => {
    const { key, used } = fakeKey();
    const q = new NearSubmitQueue(key);
    const out = await Promise.all(Array.from({ length: 20 }, () => q.call(call)));
    expect(new Set(used).size).toBe(20);
    expect(used).toEqual(Array.from({ length: 20 }, (_, i) => 101n + BigInt(i)));
    expect(new Set(out.map((o) => o.txHash)).size).toBe(20);
  });

  it("a_stale_nonce_is_re_read_from_chain_and_retried", async () => {
    const { key, used } = fakeKey(100n, true);
    const q = new NearSubmitQueue(key);
    await Promise.all([q.call(call), q.call(call)]);
    expect(used).toEqual([151n, 152n]);
  });
});
