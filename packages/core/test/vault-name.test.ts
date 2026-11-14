import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalLimits, commitmentBytes, isVaultName, matchesCommitment, randomSalt, vaultNameFor, type VaultCommitment } from "../src/index.js";

const base: VaultCommitment = {
  owner: "alice.near",
  chainKey: "base",
  borrower: "0x000000000000000000000000000000000000bEEF",
  limits: {
    trigger_hf_bps: 11_000,
    target_hf_bps: 13_000,
    max_per_rescue: "5000000",
    daily_cap: "10000000",
    cooldown_secs: 600,
    max_fee_per_gas: "1000000000",
    max_gas_limit: "400000",
  },
  salt: "00112233445566778899aabbccddeeff",
};

describe("vault name commitment", () => {
  it("is_bkst_plus_the_first_20_hex_of_sha256_of_the_canonical_bytes", async () => {
    const name = await vaultNameFor(base);
    const want = createHash("sha256").update(commitmentBytes(base)).digest("hex").slice(0, 20);
    expect(name).toBe(`bkst-${want}.near`);
    expect(isVaultName(name)).toBe(true);
  });

  it("is_stable_for_the_same_fields_including_key_order_of_limits", async () => {
    const reversed = Object.fromEntries(Object.entries(base.limits).reverse()) as unknown as VaultCommitment["limits"];
    const reordered = { ...base, limits: reversed };
    expect(await vaultNameFor(reordered)).toBe(await vaultNameFor(base));
    // Pinned vector: changing the encoding breaks every pending request, so it must be deliberate.
    expect(await vaultNameFor(base)).toMatchInlineSnapshot(`"bkst-154c41752f2e9587b6d7.near"`);
  });

  it("any_changed_field_changes_the_name", async () => {
    const name = await vaultNameFor(base);
    const variants: VaultCommitment[] = [
      { ...base, owner: "mallory.near" },
      { ...base, chainKey: "arbitrum" },
      { ...base, borrower: "0x000000000000000000000000000000000000bEEe" },
      { ...base, salt: "00112233445566778899aabbccddeef0" },
      ...(Object.keys(base.limits) as (keyof VaultCommitment["limits"])[]).map((k) => ({
        ...base,
        limits: { ...base.limits, [k]: typeof base.limits[k] === "number" ? (base.limits[k] as number) + 1 : `${base.limits[k]}1` },
      })),
    ];
    const names = await Promise.all(variants.map(vaultNameFor));
    for (const n of names) expect(n).not.toBe(name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("length_prefixing_keeps_field_boundaries_apart", async () => {
    const a = await vaultNameFor({ ...base, owner: "ab.near", chainKey: "base" });
    const b = await vaultNameFor({ ...base, owner: "ab.nearb", chainKey: "ase" });
    expect(a).not.toBe(b);
  });

  it("refuses_non_canonical_inputs_instead_of_hashing_them", () => {
    expect(() => canonicalLimits({ ...base.limits, cooldown_secs: 1.5 })).toThrow(/cooldown_secs/);
    expect(() => canonicalLimits({ ...base.limits, daily_cap: "010" })).toThrow(/daily_cap/);
    expect(() => canonicalLimits({ ...base.limits, extra: 1 } as never)).toThrow(/seven keys/);
    expect(() => commitmentBytes({ ...base, salt: "XYZ" })).toThrow(/salt/);
    expect(() => commitmentBytes({ ...base, borrower: "alice.near" })).toThrow(/borrower/);
  });

  it("matchesCommitment_is_false_for_a_wrong_id_or_bad_fields", async () => {
    const name = await vaultNameFor(base);
    expect(await matchesCommitment(name, base)).toBe(true);
    expect(await matchesCommitment(name, { ...base, owner: "mallory.near" })).toBe(false);
    expect(await matchesCommitment(name, { ...base, salt: "bad" })).toBe(false);
  });

  it("random_salts_are_32_hex_and_differ", () => {
    const a = randomSalt();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(randomSalt()).not.toBe(a);
  });
});
