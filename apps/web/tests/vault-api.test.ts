import { vaultNameFor } from "@backstop/core";
import { beforeEach, describe, expect, it } from "vitest";
import { handleCreate, handleGet, type StoredRequest, type VaultApiDeps, type VaultApiStore } from "@/lib/vault-api";
import type { AccessKeyInfo, AccountInfo } from "@/lib/near-rpc";
import type { CreateBody } from "@/lib/vault-requests";
import { hexToNearCodeHash } from "@/lib/validate";

const PK = "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847";
const CODE_HASH = "ab".repeat(32);
const NO_CODE = "11111111111111111111111111111111";
const LIMITS = { trigger_hf_bps: 11_000, target_hf_bps: 13_000, max_per_rescue: "5000000", daily_cap: "10000000", cooldown_secs: 600, max_fee_per_gas: "1000000000", max_gas_limit: "400000" };

async function body(over: Partial<Omit<CreateBody, "vaultId">> = {}): Promise<CreateBody> {
  const fields = { owner: "alice.near", chainKey: "base", borrower: "0x000000000000000000000000000000000000bEEF", limits: LIMITS, salt: "00112233445566778899aabbccddeeff", ...over };
  return { vaultId: await vaultNameFor(fields), ...fields };
}

class MemStore implements VaultApiStore {
  rows = new Map<string, StoredRequest>();
  async insertIfAbsent(req: CreateBody) {
    const cur = this.rows.get(req.vaultId);
    if (cur) {
      if (JSON.stringify({ ...cur, status: undefined, lastError: undefined, createdAt: undefined, updatedAt: undefined }) !== JSON.stringify({ ...req, status: undefined, lastError: undefined, createdAt: undefined, updatedAt: undefined })) {
        throw Object.assign(new Error("A different request exists."), { name: "VaultRequestConflictError" });
      }
      return { request: cur, inserted: false };
    }
    const row: StoredRequest = { ...req, status: "pending", lastError: null, createdAt: "2026-11-14T12:00:00.000Z", updatedAt: "2026-11-14T12:00:00.000Z" };
    this.rows.set(req.vaultId, row);
    return { request: row, inserted: true };
  }
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async listByOwner(owner: string) {
    return [...this.rows.values()].filter((r) => r.owner === owner);
  }
}

let store: MemStore;
let account: AccountInfo | null;
let keys: AccessKeyInfo[] | null;

const deps = (): VaultApiDeps => ({
  store: async () => store,
  account: async () => account,
  accessKeys: async () => keys,
  deployerPublicKey: PK,
  codeHash: CODE_HASH,
  allowedOwners: null,
  now: () => new Date("2026-11-14T12:00:00Z"),
});

beforeEach(() => {
  store = new MemStore();
  account = { amount: 3n * 10n ** 24n, codeHash: NO_CODE, storageUsage: 200 };
  keys = [{ publicKey: PK, fullAccess: true }];
});

describe("POST /api/vaults", () => {
  it("registers_a_fresh_account_with_only_the_setup_key_as_pending_and_is_idempotent", async () => {
    const b = await body();
    const first = await handleCreate(b, deps());
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ request: { vaultId: b.vaultId, status: "pending" } });
    const again = await handleCreate(b, deps());
    expect(again.status).toBe(200);
    expect(store.rows.size).toBe(1);
  });

  it("refuses_fields_that_do_not_match_the_vault_name", async () => {
    const b = await body();
    const r = await handleCreate({ ...b, owner: "mallory.near" }, deps());
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: expect.stringMatching(/do not match the vault name/) });
    expect(store.rows.size).toBe(0);
  });

  it("refuses_when_the_account_does_not_exist_and_says_the_near_was_returned_if_the_name_was_taken", async () => {
    account = null;
    keys = null;
    const r = await handleCreate(await body(), deps());
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: expect.stringMatching(/NEAR was returned/) });
  });

  it("refuses_an_account_with_any_key_but_exactly_the_setup_key", async () => {
    keys = [{ publicKey: PK, fullAccess: true }, { publicKey: "ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcc", fullAccess: true }];
    expect((await handleCreate(await body(), deps())).status).toBe(409);
    keys = [{ publicKey: PK, fullAccess: false }];
    expect((await handleCreate(await body(), deps())).status).toBe(409);
  });

  it("accepts_an_already_deployed_keyless_vault_with_the_published_code_and_refuses_other_code", async () => {
    account = { amount: 3n * 10n ** 24n, codeHash: hexToNearCodeHash(CODE_HASH), storageUsage: 280_000 };
    keys = [];
    expect((await handleCreate(await body(), deps())).status).toBe(201);
    account = { amount: 3n * 10n ** 24n, codeHash: hexToNearCodeHash("cd".repeat(32)), storageUsage: 280_000 };
    expect((await handleCreate(await body({ salt: "ffffffffffffffffffffffffffffffff" }), deps())).status).toBe(409);
  });

  it("validates_chain_borrower_checksum_limits_and_shape", async () => {
    expect((await handleCreate(await body({ chainKey: "solana" }), deps())).status).toBe(400);
    expect((await handleCreate(await body({ borrower: "0x000000000000000000000000000000000000beef" }), deps())).status).toBe(400);
    expect((await handleCreate(await body({ limits: { ...LIMITS, target_hf_bps: 10_000 } }), deps())).status).toBe(400);
    expect((await handleCreate({ ...(await body()), extra: 1 }, deps())).status).toBe(400);
    expect((await handleCreate("nope", deps())).status).toBe(400);
  });

  it("is_closed_without_a_setup_key_configured", async () => {
    expect((await handleCreate(await body(), { ...deps(), deployerPublicKey: undefined })).status).toBe(503);
  });

  it("refuses_a_ninth_open_vault_for_one_owner", async () => {
    for (let i = 0; i < 8; i++) {
      const b = await body({ salt: i.toString(16).padStart(32, "0") });
      store.rows.set(b.vaultId, { ...b, status: "ready", lastError: null, createdAt: "", updatedAt: "" });
    }
    const r = await handleCreate(await body(), deps());
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: expect.stringMatching(/limit of 8 vaults/) });
  });
});

describe("invite-only creation", () => {
  it("refuses_an_owner_who_is_not_on_the_list_with_403_before_touching_the_chain_or_store", async () => {
    let touched = false;
    const spy: VaultApiDeps = { ...deps(), allowedOwners: ["bob.near"], store: async () => { touched = true; return store; }, account: async () => { touched = true; return account; } };
    const r = await handleCreate(await body(), spy);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "Vault creation is invite-only right now. Ask the Backstop team to add alice.near to the invite list." });
    expect(touched).toBe(false);
    expect(store.rows.size).toBe(0);
  });
  it("accepts_a_listed_owner_and_an_open_site_with_no_list", async () => {
    expect((await handleCreate(await body(), { ...deps(), allowedOwners: ["bob.near", "alice.near"] })).status).toBe(201);
    expect((await handleCreate(await body({ salt: "ffffffffffffffffffffffffffffffff" }), { ...deps(), allowedOwners: null })).status).toBe(201);
  });
  it("allowed_query_answers_for_that_account_only_and_never_leaks_the_list", async () => {
    const closed = { ...deps(), allowedOwners: ["alice.near", "bob.near"] };
    const yes = await handleGet(new URLSearchParams({ allowed: "alice.near" }), closed);
    expect(yes).toEqual({ status: 200, body: { allowed: true, inviteOnly: true } });
    const no = await handleGet(new URLSearchParams({ allowed: "mallory.near" }), closed);
    expect(no).toEqual({ status: 200, body: { allowed: false, inviteOnly: true } });
    expect(JSON.stringify([yes, no])).not.toContain("bob.near");
    expect((await handleGet(new URLSearchParams({ allowed: "mallory.near" }), { ...deps(), allowedOwners: null })).body).toEqual({ allowed: true, inviteOnly: false });
  });
  it("allowed_query_must_be_the_only_parameter_and_a_valid_account", async () => {
    expect((await handleGet(new URLSearchParams({ allowed: "Bad Owner" }), deps())).status).toBe(400);
    expect((await handleGet(new URLSearchParams({ allowed: "a.near", owner: "a.near" }), deps())).status).toBe(400);
  });
});

describe("GET /api/vaults", () => {
  it("lists_an_owner_and_shows_one_vault_without_the_salt", async () => {
    const b = await body();
    await handleCreate(b, deps());
    const list = await handleGet(new URLSearchParams({ owner: "alice.near" }), deps());
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(b.salt);
    expect(list.body).toMatchObject({ requests: [{ vaultId: b.vaultId, status: "pending" }] });
    expect((await handleGet(new URLSearchParams({ vault: b.vaultId }), deps())).body).toMatchObject({ request: { vaultId: b.vaultId } });
    expect((await handleGet(new URLSearchParams({ vault: "bkst-ffffffffffffffffffff.near" }), deps())).body).toEqual({ request: null });
  });

  it("strictly_validates_the_query", async () => {
    expect((await handleGet(new URLSearchParams({ owner: "Bad Owner" }), deps())).status).toBe(400);
    expect((await handleGet(new URLSearchParams({ vault: "alice.near" }), deps())).status).toBe(400);
    expect((await handleGet(new URLSearchParams(), deps())).status).toBe(400);
    expect((await handleGet(new URLSearchParams({ owner: "a.near", vault: "bkst-ffffffffffffffffffff.near" }), deps())).status).toBe(400);
  });
});
