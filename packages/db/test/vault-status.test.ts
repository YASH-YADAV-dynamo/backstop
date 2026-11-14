import type { VaultStatus } from "@backstop/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireFileLock,
  createTableSql,
  fromStatusRow,
  JsonVaultStatusStore,
  openVaultStatusReader,
  toStatusRow,
  vaultStatus,
} from "../src/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "backstop-vs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const row = (policyId: string, over: Partial<VaultStatus> = {}): VaultStatus => ({
  policyId,
  chainId: 8453,
  checkedAt: "2026-11-14T12:00:00.000Z",
  state: "watching",
  reason: null,
  lastError: null,
  hf: "1500000000000000000",
  usdc: "10000000",
  usdcWallet: "1000000",
  gasWei: "1000000000000000",
  debt: "5000000",
  readiness: { funds: "ok", gas: "ok", debt: "usdc" },
  ...over,
});

describe("vault status store (JSON)", () => {
  it("upsert_replaces_the_row_of_each_vault_and_keeps_the_others", async () => {
    const s = new JsonVaultStatusStore(join(dir, "vs.json"));
    await s.upsert([row("b.near"), row("a.near")]);
    await s.upsert([row("a.near", { state: "refused", reason: "HAS_ACCESS_KEYS", lastError: "keyed", hf: null })]);
    const all = await s.list();
    expect(all.map((r) => r.policyId)).toEqual(["a.near", "b.near"]);
    expect(all[0]!.state).toBe("refused");
    expect(await s.get("b.near")).toEqual(row("b.near"));
    expect(await s.get("missing.near")).toBeNull();
  });

  it("reader_returns_no_rows_before_the_bot_has_written_any", async () => {
    const r = await openVaultStatusReader({ VAULT_STATUS_FILE: join(dir, "none.json") });
    expect(await r.list()).toEqual([]);
    expect(await r.get("a.near")).toBeNull();
  });

  it("malformed_rows_are_rejected_on_write_and_on_read", async () => {
    const s = new JsonVaultStatusStore(join(dir, "vs.json"));
    await expect(s.upsert([row("a.near", { hf: "1.5" as string })])).rejects.toThrow(/hf/);
    await writeFile(join(dir, "vs.json"), JSON.stringify([{ ...row("a.near"), state: "protected" }]));
    await expect(s.list()).rejects.toThrow(/state/);
  });
});

describe("vault_status table", () => {
  it("row_mapping_round_trips_and_the_table_has_the_documented_columns", () => {
    const r = row("a.near", { state: "blocked", reason: "DEBT_NOT_USDC", readiness: { funds: "low", gas: "empty", debt: "other" } });
    expect(fromStatusRow(toStatusRow(r))).toEqual(r);
    const ddl = createTableSql(vaultStatus);
    for (const col of ["vault_id", "chain_id", "last_checked_at", "hf", "usdc", "gas_eth", "debt", "state", "last_error", "readiness"]) {
      expect(ddl).toContain(`"${col}"`);
    }
    expect(ddl).toMatch(/"vault_id" text PRIMARY KEY/);
  });
});

describe("instance lock", () => {
  it("a_second_instance_cannot_take_the_lock_until_the_first_releases_it", async () => {
    const path = join(dir, "svc.lock");
    const first = await acquireFileLock(path);
    expect(first).not.toBeNull();
    expect(await acquireFileLock(path)).toBeNull();
    await first!.release();
    const again = await acquireFileLock(path);
    expect(again).not.toBeNull();
    await again!.release();
  });

  it("a_stale_lock_of_a_dead_process_is_taken_over", async () => {
    const path = join(dir, "svc.lock");
    await writeFile(path, "999999999");
    const lock = await acquireFileLock(path);
    expect(lock).not.toBeNull();
    await lock!.release();
  });
});
