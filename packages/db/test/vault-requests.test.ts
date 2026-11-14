import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canTransition,
  createTableSql,
  fromRequestRow,
  JsonVaultRequestStore,
  openVaultRequestStore,
  toRequestRow,
  VAULT_REQUEST_STATUSES,
  VaultRequestConflictError,
  vaultRequests,
  type NewVaultRequest,
} from "../src/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "backstop-vr-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const req = (n: number, over: Partial<NewVaultRequest> = {}): NewVaultRequest => ({
  vaultId: `bkst-${String(n).padStart(20, "0")}.near`,
  owner: "alice.near",
  chainKey: "base",
  borrower: "0x000000000000000000000000000000000000bEEF",
  limits: { trigger_hf_bps: 11_000, target_hf_bps: 13_000, max_per_rescue: "5000000", daily_cap: "10000000", cooldown_secs: 600, max_fee_per_gas: "1000000000", max_gas_limit: "400000" },
  salt: "00112233445566778899aabbccddeeff",
  ...over,
});

const t0 = new Date("2026-11-14T12:00:00.000Z");
const t1 = new Date("2026-11-14T12:01:00.000Z");

describe("vault request store (JSON)", () => {
  it("insert_is_idempotent_the_same_body_twice_is_one_row", async () => {
    const s = new JsonVaultRequestStore(join(dir, "vr.json"));
    const a = await s.insertIfAbsent(req(1), t0);
    const b = await s.insertIfAbsent(req(1), t1);
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.request).toEqual(a.request);
    expect(a.request).toMatchObject({ status: "pending", attempts: 0, lastError: null, createdAt: t0.toISOString() });
    expect(await s.listByOwner("alice.near")).toHaveLength(1);
  });

  it("a_different_body_under_the_same_vault_id_is_refused", async () => {
    const s = new JsonVaultRequestStore(join(dir, "vr.json"));
    await s.insertIfAbsent(req(1), t0);
    await expect(s.insertIfAbsent(req(1, { owner: "mallory.near" }), t1)).rejects.toBeInstanceOf(VaultRequestConflictError);
    expect((await s.get(req(1).vaultId))!.owner).toBe("alice.near");
  });

  it("lists_by_owner_pending_and_ready", async () => {
    const s = new JsonVaultRequestStore(join(dir, "vr.json"));
    await s.insertIfAbsent(req(1), t0);
    await s.insertIfAbsent(req(2, { owner: "bob.near" }), t0);
    await s.insertIfAbsent(req(3), t1);
    await s.update(req(1).vaultId, { status: "deploying" }, t1);
    await s.update(req(1).vaultId, { status: "ready" }, t1);
    await s.update(req(2).vaultId, { status: "aborted", lastError: "underfunded" }, t1);
    expect((await s.listByOwner("alice.near")).map((r) => r.vaultId)).toEqual([req(1).vaultId, req(3).vaultId]);
    expect((await s.listPending()).map((r) => r.vaultId)).toEqual([req(3).vaultId]);
    expect((await s.listReady()).map((r) => r.vaultId)).toEqual([req(1).vaultId]);
    expect(await s.get("bkst-ffffffffffffffffffff.near")).toBeNull();
  });

  it("update_counts_attempts_keeps_the_error_and_refuses_leaving_a_final_state", async () => {
    const s = new JsonVaultRequestStore(join(dir, "vr.json"));
    await s.insertIfAbsent(req(1), t0);
    const r = await s.update(req(1).vaultId, { status: "deploying", attempts: 1, lastError: "rpc down" }, t1);
    expect(r).toMatchObject({ status: "deploying", attempts: 1, lastError: "rpc down", updatedAt: t1.toISOString(), createdAt: t0.toISOString() });
    await s.update(req(1).vaultId, { status: "failed" }, t1);
    await expect(s.update(req(1).vaultId, { status: "pending" }, t1)).rejects.toThrow(/cannot become pending/);
    await expect(s.update("bkst-ffffffffffffffffffff.near", { attempts: 1 }, t1)).rejects.toThrow(/No vault request/);
  });

  it("malformed_requests_are_rejected_on_write_and_on_read", async () => {
    const s = new JsonVaultRequestStore(join(dir, "vr.json"));
    await expect(s.insertIfAbsent(req(1, { vaultId: "alice.near" }), t0)).rejects.toThrow(/vaultId/);
    await expect(s.insertIfAbsent(req(1, { salt: "short" }), t0)).rejects.toThrow(/salt/);
    await expect(s.insertIfAbsent({ ...req(1), limits: { ...req(1).limits, cooldown_secs: "600" as unknown as number } }, t0)).rejects.toThrow(/cooldown_secs/);
    await writeFile(join(dir, "vr.json"), JSON.stringify([{ ...req(1), status: "done", attempts: 0, lastError: null, createdAt: t0.toISOString(), updatedAt: t0.toISOString() }]));
    await expect(s.listPending()).rejects.toThrow(/status/);
  });

  it("opener_uses_the_json_file_without_a_database_url", async () => {
    const s = await openVaultRequestStore({ VAULT_REQUESTS_FILE: join(dir, "none.json") });
    expect(await s.listReady()).toEqual([]);
    await s.close();
  });
});

describe("vault request state machine", () => {
  it("only_pending_and_deploying_can_move_and_final_states_never_change", () => {
    expect(canTransition("pending", "deploying")).toBe(true);
    expect(canTransition("pending", "aborted")).toBe(true);
    expect(canTransition("deploying", "ready")).toBe(true);
    expect(canTransition("deploying", "pending")).toBe(false);
    for (const final of ["ready", "failed", "aborted"] as const) {
      for (const to of VAULT_REQUEST_STATUSES) expect(canTransition(final, to)).toBe(false);
    }
  });
});

describe("vault_requests table", () => {
  it("row_mapping_round_trips_and_the_table_has_the_documented_columns", () => {
    const r = { ...req(1), status: "deploying" as const, attempts: 2, lastError: "x", createdAt: t0.toISOString(), updatedAt: t1.toISOString() };
    expect(fromRequestRow(toRequestRow(r))).toEqual(r);
    const ddl = createTableSql(vaultRequests);
    for (const col of ["vault_id", "owner", "chain_key", "borrower", "limits_json", "salt", "status", "attempts", "last_error", "created_at", "updated_at"]) {
      expect(ddl).toContain(`"${col}"`);
    }
    expect(ddl).toMatch(/"vault_id" text PRIMARY KEY/);
    expect(ddl).toMatch(/"last_error" text(,|\n)/);
  });
});
