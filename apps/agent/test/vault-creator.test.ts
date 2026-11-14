import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair, type Action } from "near-api-js";
import { sha256 } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultCreateDeposit } from "@backstop/config";
import { vaultNameFor, type LimitsJson } from "@backstop/core";
import { JsonVaultRequestStore, type NewVaultRequest } from "@backstop/db";
import { discoverVaults, expectedCodeHash, type Admission } from "../src/discover.js";
import { VaultService, type ServiceIO } from "../src/service.js";
import {
  creatorConfig,
  processVaultRequests,
  requestPlan,
  vaultDeployActions,
  type CreatorAccount,
  type CreatorConfig,
  type CreatorIO,
} from "../src/vault-creator.js";
import { config as policyConfig, limits as policyLimits } from "./helpers.js";

const BOT = "agent.near";
const DEPLOY_KEY = KeyPair.fromRandom("ed25519");
const DEPLOY_PK = DEPLOY_KEY.getPublicKey().toString();
const CODE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const CODE_HASH = sha256(CODE).slice(2);
const NEED = vaultCreateDeposit(CODE.length);

const LIMITS: LimitsJson = { trigger_hf_bps: 11_000, target_hf_bps: 13_000, max_per_rescue: "5000000", daily_cap: "10000000", cooldown_secs: 600, max_fee_per_gas: "1000000000", max_gas_limit: "400000" };

const cfg: CreatorConfig = {
  deployerPublicKey: DEPLOY_PK,
  code: CODE,
  codeHash: CODE_HASH,
  botAccountId: BOT,
  feeAccount: "fees.backstop.near",
  feeBps: 10,
  maxAttempts: 3,
  activateAfterMs: 300_000,
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "backstop-vc-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function request(over: Partial<Omit<NewVaultRequest, "vaultId">> = {}): Promise<NewVaultRequest> {
  const fields = { owner: "alice.near", chainKey: "base", borrower: "0x000000000000000000000000000000000000bEEF", limits: LIMITS, salt: "00112233445566778899aabbccddeeff", ...over };
  return { vaultId: await vaultNameFor(fields), ...fields };
}

const admitted = (id: string): Admission => ({ ok: true, policyId: id, config: policyConfig, limits: policyLimits });
const notActivated = (id: string): Admission => ({ ok: false, policyId: id, chainId: 8453, reason: "NOT_ACTIVATED", message: "not activated" });

interface Chain {
  accounts: Map<string, CreatorAccount>;
  registered: Set<string>;
  sent: { id: string; kinds: string[]; actions: Action[] }[];
  activated: string[];
  failSend: number;
  admission: (id: string) => Admission;
}

function fake(chain: Partial<Chain> = {}) {
  const c: Chain = { accounts: new Map(), registered: new Set(), sent: [], activated: [], failSend: 0, admission: admitted, ...chain };
  let t = Date.parse("2026-11-14T12:00:00Z");
  const store = new JsonVaultRequestStore(join(dir, "vr.json"));
  const logs: string[] = [];
  const io: CreatorIO = {
    now: () => new Date(t),
    log: (l) => logs.push(l),
    store,
    account: async (id) => c.accounts.get(id) ?? null,
    usdcRegistered: async (id) => c.registered.has(id),
    registerUsdc: async (id) => {
      c.registered.add(id);
      return "RegTx";
    },
    sendAsVault: async (id, actions) => {
      if (c.failSend > 0) {
        c.failSend -= 1;
        throw new Error("RPC timed out");
      }
      c.sent.push({ id, kinds: actions.map((a) => a.enum), actions });
      const acct = c.accounts.get(id)!;
      if (actions.some((a) => a.enum === "deleteAccount")) c.accounts.delete(id);
      else c.accounts.set(id, { ...acct, codeHashHex: CODE_HASH, keys: [] });
      return "Tx";
    },
    activate: async (id) => void c.activated.push(id),
    admit: async (id) => c.admission(id),
  };
  return { io, store, chain: c, logs, tick: (ms: number) => (t += ms), at: () => new Date(t) };
}

const funded = (balance = NEED): CreatorAccount => ({ balance, codeHashHex: null, keys: [{ publicKey: DEPLOY_PK, fullAccess: true }] });

describe("vault creator", () => {
  it("deploys_in_one_transaction_code_new_activate_then_deletes_the_deploy_key", async () => {
    const r = await request();
    const f = fake({ accounts: new Map([[r.vaultId, funded()]]) });
    await f.store.insertIfAbsent(r, f.at());
    expect(await processVaultRequests(f.io, cfg)).toBe(1);
    expect(f.chain.registered.has(r.vaultId)).toBe(true);
    expect(f.chain.sent).toHaveLength(1);
    expect(f.chain.sent[0]!.kinds).toEqual(["deployContract", "functionCall", "functionCall", "deleteKey"]);
    const [, init, activate, del] = f.chain.sent[0]!.actions;
    expect(init!.functionCall!.methodName).toBe("new");
    expect(JSON.parse(new TextDecoder().decode(init!.functionCall!.args))).toMatchObject({ owner: "alice.near", agent: BOT, on_behalf_of: r.borrower, limits: LIMITS });
    expect(activate!.functionCall!.methodName).toBe("activate");
    expect(del!.deleteKey!.publicKey.toString()).toBe(DEPLOY_PK);
    expect((await f.store.get(r.vaultId))!.status).toBe("ready");
  });

  it("never_adds_a_key_or_transfers_in_the_deploy_transaction", () => {
    const kinds = vaultDeployActions(CODE, {}, DEPLOY_PK).map((a) => a.enum);
    expect(kinds).not.toContain("addKey");
    expect(kinds).not.toContain("transfer");
    expect(kinds.at(-1)).toBe("deleteKey");
  });

  it("fields_that_do_not_match_the_vault_name_are_never_deployed_or_refunded", async () => {
    const r = await request();
    const f = fake({ accounts: new Map([[r.vaultId, funded()]]) });
    // Written past the API (which refuses this) to prove the bot re-checks on its own.
    await f.store.insertIfAbsent({ ...r, owner: "mallory.near" }, f.at());
    await processVaultRequests(f.io, cfg);
    expect(f.chain.sent).toEqual([]);
    expect(await f.store.get(r.vaultId)).toMatchObject({ status: "failed", lastError: expect.stringMatching(/do not match its vault name/) });
  });

  it("an_underfunded_account_is_deleted_and_its_near_returned_to_the_owner", async () => {
    const r = await request();
    const f = fake({ accounts: new Map([[r.vaultId, funded(NEED - 1n)]]) });
    await f.store.insertIfAbsent(r, f.at());
    await processVaultRequests(f.io, cfg);
    expect(f.chain.sent.map((s) => s.kinds)).toEqual([["deleteAccount"]]);
    expect(f.chain.sent[0]!.actions[0]!.deleteAccount!.beneficiaryId).toBe("alice.near");
    expect(f.chain.accounts.has(r.vaultId)).toBe(false);
    expect((await f.store.get(r.vaultId))!.status).toBe("aborted");
  });

  it("an_account_with_any_other_key_is_not_touched", async () => {
    const r = await request();
    const other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    const f = fake({ accounts: new Map([[r.vaultId, { ...funded(), keys: [{ publicKey: DEPLOY_PK, fullAccess: true }, { publicKey: other, fullAccess: true }] }]]) });
    await f.store.insertIfAbsent(r, f.at());
    await processVaultRequests(f.io, cfg);
    expect(f.chain.sent).toEqual([]);
    expect((await f.store.get(r.vaultId))!.status).toBe("failed");
  });

  it("retries_failures_and_after_three_aborts_with_a_refund_to_the_owner", async () => {
    const r = await request();
    const f = fake({ accounts: new Map([[r.vaultId, funded()]]), failSend: 3 });
    await f.store.insertIfAbsent(r, f.at());
    await processVaultRequests(f.io, cfg);
    expect(await f.store.get(r.vaultId)).toMatchObject({ status: "deploying", attempts: 1, lastError: "RPC timed out" });
    await processVaultRequests(f.io, cfg);
    expect((await f.store.get(r.vaultId))!.attempts).toBe(2);
    await processVaultRequests(f.io, cfg);
    // third failure spends the budget: the account is deleted with the owner as beneficiary
    expect(f.chain.sent.map((s) => s.kinds)).toEqual([["deleteAccount"]]);
    expect(await f.store.get(r.vaultId)).toMatchObject({ status: "aborted", attempts: 3 });
  });

  it("an_already_deployed_keyless_vault_with_the_published_code_is_only_admitted", async () => {
    const r = await request();
    const f = fake({ accounts: new Map([[r.vaultId, { balance: NEED, codeHashHex: CODE_HASH, keys: [] }]]) });
    await f.store.insertIfAbsent(r, f.at());
    expect(await processVaultRequests(f.io, cfg)).toBe(1);
    expect(f.chain.sent).toEqual([]);
    expect((await f.store.get(r.vaultId))!.status).toBe("ready");
  });

  it("a_keyless_account_with_other_code_is_failed_not_admitted", async () => {
    const r = await request();
    const f = fake({ accounts: new Map([[r.vaultId, { balance: NEED, codeHashHex: "cd".repeat(32), keys: [] }]]) });
    await f.store.insertIfAbsent(r, f.at());
    await processVaultRequests(f.io, cfg);
    expect(await f.store.get(r.vaultId)).toMatchObject({ status: "failed", lastError: expect.stringMatching(/unexpected contract code/) });
  });

  it("waits_for_activation_then_nudges_it_and_marks_ready_once_admitted", async () => {
    const r = await request();
    let activated = false;
    const f = fake({ accounts: new Map([[r.vaultId, funded()]]), admission: (id) => (activated ? admitted(id) : notActivated(id)) });
    await f.store.insertIfAbsent(r, f.at());
    expect(await processVaultRequests(f.io, cfg)).toBe(0);
    expect(await f.store.get(r.vaultId)).toMatchObject({ status: "deploying", attempts: 0 });
    f.tick(60_000);
    await processVaultRequests(f.io, cfg);
    expect(f.chain.activated).toEqual([]);
    f.tick(300_000);
    await processVaultRequests(f.io, cfg);
    expect(f.chain.activated).toEqual([r.vaultId]);
    activated = true;
    expect(await processVaultRequests(f.io, cfg)).toBe(1);
    expect((await f.store.get(r.vaultId))!.status).toBe("ready");
    expect(f.chain.sent).toHaveLength(1);
  });

  it("refuses_bad_limits_and_unchecksummed_loan_addresses_before_any_deploy", async () => {
    const bad = await request({ limits: { ...LIMITS, target_hf_bps: 10_500 } });
    expect(requestPlan({ ...bad, status: "pending", attempts: 0, lastError: null, createdAt: "", updatedAt: "" }, cfg)).toMatchObject({ ok: false, problem: expect.stringMatching(/target/) });
    const lower = await request({ borrower: "0x000000000000000000000000000000000000beef" });
    expect(requestPlan({ ...lower, status: "pending", attempts: 0, lastError: null, createdAt: "", updatedAt: "" }, cfg)).toMatchObject({ ok: false, problem: expect.stringMatching(/checksum/) });
    const f = fake({ accounts: new Map([[bad.vaultId, funded()]]) });
    await f.store.insertIfAbsent(bad, f.at());
    await processVaultRequests(f.io, cfg);
    expect(f.chain.sent.map((s) => s.kinds)).toEqual([["deleteAccount"]]);
  });
});

describe("creator config", () => {
  const env = { VAULT_DEPLOYER_PRIVATE_KEY: DEPLOY_KEY.toString(), POLICY_WASM_PATH: "policy.wasm", FEE_ACCOUNT_ID: "fees.near", FEE_BPS: 10 };
  const read = async () => CODE;

  it("is_off_without_a_deploy_key", async () => {
    expect(await creatorConfig({ FEE_BPS: 10 }, CODE_HASH, BOT, read)).toBeNull();
  });

  it("refuses_a_wasm_that_is_not_the_published_code", async () => {
    await expect(creatorConfig(env, "ab".repeat(32), BOT, read)).rejects.toThrow(/not the published policy code hash/);
  });

  it("refuses_a_deploy_key_that_does_not_match_the_public_key_the_site_shows", async () => {
    const other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    await expect(creatorConfig({ ...env, NEXT_PUBLIC_VAULT_DEPLOYER_PK: other }, CODE_HASH, BOT, read)).rejects.toThrow(/NEXT_PUBLIC_VAULT_DEPLOYER_PK/);
    const ok = await creatorConfig({ ...env, NEXT_PUBLIC_VAULT_DEPLOYER_PK: DEPLOY_PK }, CODE_HASH, BOT, read);
    expect(ok!.deployerPublicKey).toBe(DEPLOY_PK);
    expect(JSON.stringify({ ...ok, code: undefined })).not.toContain(DEPLOY_KEY.toString().slice(8));
  });
});

describe("code hash and discovery without a factory", () => {
  it("the_service_refuses_to_start_without_a_factory_or_policy_code_hash", () => {
    expect(() => expectedCodeHash(null, undefined)).toThrow(/POLICY_CODE_HASH/);
    expect(expectedCodeHash(null, "ab".repeat(32))).toBe("ab".repeat(32));
    expect(expectedCodeHash("cd".repeat(32), undefined)).toBe("cd".repeat(32));
    expect(() => expectedCodeHash("cd".repeat(32), "ab".repeat(32))).toThrow(/not the factory's/);
  });

  it("discovers_ready_created_vaults_next_to_operator_vaults_with_no_factory", async () => {
    const view = async () => {
      throw new Error("no factory configured: nothing may be viewed");
    };
    expect(await discoverVaults(view, { policyIds: ["op.near"], created: async () => ["bkst-1.near", "op.near"] })).toEqual(["bkst-1.near", "op.near"]);
  });

  it("the_service_runs_vault_creation_in_the_background_and_never_in_a_dry_run", async () => {
    let runs = 0;
    const io: ServiceIO = {
      now: () => new Date("2026-11-14T12:00:00Z"),
      log: () => {},
      discover: async () => [],
      createVaults: async () => {
        runs += 1;
        return 0;
      },
      admit: async () => {
        throw new Error("unused");
      },
      readNear: async () => {
        throw new Error("unused");
      },
      readLoans: async () => new Map(),
      chainFees: async () => ({ maxFeePerGas: 0n, l1Fee: 0n }),
      pendingResumes: async () => new Set(),
      runTask: async () => ({}),
      statusStore: { upsert: async () => {} },
      alert: async () => {},
    };
    const live = new VaultService(io);
    await live.pass();
    await live.idle();
    expect(runs).toBe(1);
    await new VaultService(io, { dryRun: true }).pass();
    expect(runs).toBe(1);
  });
});
