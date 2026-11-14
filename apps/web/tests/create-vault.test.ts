import { readFileSync } from "node:fs";
import { NEAR } from "@backstop/config/registry";
import { vaultCreateDeposit } from "@backstop/config/vault-plan";
import { describe, expect, it } from "vitest";
import { classifyDebt, debtBlockReason } from "@/lib/debt";
import { buildCreateBody, buildCreateLimits, createBlockReason, createDeposit, DEFAULT_FIELDS, HIDDEN_LIMITS, NOT_RETURNED_YOCTO, returnedOnClose, type CreateInputs } from "@/lib/create-vault";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const DEPOSIT = vaultCreateDeposit(277_247);
const ready: CreateInputs = {
  creationOpen: true,
  deposit: DEPOSIT,
  nearBalance: 10n * 10n ** 24n,
  loanAddress: ADDRESS,
  debtKind: "usdc",
  chainName: "Base",
  fields: DEFAULT_FIELDS,
  vaultCount: 0,
  owner: "alice.near",
  invite: { allowed: true, inviteOnly: false },
};

describe("default limits", () => {
  it("default_limits_match_scripts_DEFAULT_LIMITS", () => {
    const src = readFileSync(new URL("../../../scripts/src/lib/limits.ts", import.meta.url), "utf8");
    const num = (name: string) => Number(new RegExp(`${name}:\\s*([\\d_]+)`).exec(src)![1]!.replaceAll("_", ""));
    const str = (name: string) => new RegExp(`${name}:\\s*"(\\d+)"`).exec(src)![1]!;
    const limits = buildCreateLimits(DEFAULT_FIELDS);
    if (!limits.ok) throw new Error(limits.error);
    expect(limits.value.trigger_hf_bps).toBe(num("trigger_hf_bps"));
    expect(limits.value.target_hf_bps).toBe(num("target_hf_bps"));
    expect(limits.value.max_per_rescue).toBe(str("max_per_rescue"));
    expect(limits.value.daily_cap).toBe(str("daily_cap"));
    // u64 in the contract: a JSON number, never a string
    expect(limits.value.cooldown_secs).toBe(num("cooldown_secs"));
    expect(limits.value.max_fee_per_gas).toBe(str("max_fee_per_gas"));
    expect(limits.value.max_gas_limit).toBe(str("max_gas_limit"));
    expect(HIDDEN_LIMITS.targetHf).toBe("1.30");
  });
  it("rejects limits the contract would reject", () => {
    expect(buildCreateLimits({ ...DEFAULT_FIELDS, maxPerRescue: "20", dailyCap: "10" }).ok).toBe(false);
    expect(buildCreateLimits({ ...DEFAULT_FIELDS, triggerHf: "0.9" }).ok).toBe(false);
  });
});

describe("loan_without_usdc_debt_cannot_be_protected", () => {
  it("classifies native-USDC variable debt as protectable, other debt and no debt as not", () => {
    expect(classifyDebt({ usdcVariableDebt: 5n, totalDebtBase: 5n })).toBe("usdc");
    expect(classifyDebt({ usdcVariableDebt: 0n, totalDebtBase: 5n })).toBe("other");
    expect(classifyDebt({ usdcVariableDebt: 0n, totalDebtBase: 0n })).toBe("none");
  });
  it("allows creation before the loan exists, and blocks non-USDC debt with calm copy", () => {
    expect(createBlockReason({ ...ready, debtKind: "none" })).toBeNull();
    expect(createBlockReason({ ...ready, debtKind: "other" })).toBe("This loan's debt isn't USDC. Backstop can only repay USDC debt for now.");
    expect(debtBlockReason("usdc")).toBeNull();
  });
});

describe("createBlockReason", () => {
  it("allows a funded owner with a USDC loan", () => {
    expect(createBlockReason(ready)).toBeNull();
  });
  it("waits for configuration, the debt read and a valid address", () => {
    expect(createBlockReason({ ...ready, creationOpen: false })).toBe("Vault creation opens soon.");
    expect(createBlockReason({ ...ready, deposit: null })).toBe("Vault creation opens soon.");
    expect(createBlockReason({ ...ready, debtKind: null })).toMatch(/Looking for your loan on Base/);
    expect(createBlockReason({ ...ready, loanAddress: "" })).toMatch(/Enter the address/);
    expect(createBlockReason({ ...ready, loanAddress: "0x12" })).toMatch(/0x followed by 40/);
  });
  it("not_enough_near_names_the_deposit_and_that_it_comes_back", () => {
    const r = createBlockReason({ ...ready, nearBalance: 1n * 10n ** 24n });
    expect(r).toBe("Opening a vault holds about 2.94 NEAR; you have 1 NEAR. You get it back when you close the vault.");
  });
  it("not_invited_blocks_with_the_invite_message_and_a_failed_check_fails_closed", () => {
    expect(createBlockReason({ ...ready, invite: { allowed: false, inviteOnly: true } })).toBe("Vault creation is invite-only right now. Ask the Backstop team to add alice.near to the invite list.");
    expect(createBlockReason({ ...ready, invite: "error" })).toBe("Could not check your invite; try again.");
    expect(createBlockReason({ ...ready, invite: undefined })).toBe("Checking your invite...");
    expect(createBlockReason({ ...ready, invite: { allowed: true, inviteOnly: true } })).toBeNull();
  });
  it("stops at eight vaults", () => {
    expect(createBlockReason({ ...ready, vaultCount: 8 })).toBe("You've reached the limit of 8 vaults. Close one to open another.");
  });
});

describe("deposit", () => {
  it("is_the_shared_budget_for_the_configured_wasm_size", () => {
    expect(createDeposit(undefined)).toBeNull();
    expect(createDeposit(277_247)).toBe(DEPOSIT);
  });
  it("returns_all_but_the_usdc_registration_and_at_most_the_deploy_gas", () => {
    expect(NOT_RETURNED_YOCTO).toBe(BigInt(NEAR.usdcStorageDeposit) + 20n * 10n ** 21n);
    expect(returnedOnClose(DEPOSIT)).toBe(DEPOSIT - NOT_RETURNED_YOCTO);
  });
});

describe("buildCreateBody", () => {
  it("checksums_the_borrower_and_names_the_vault_from_its_fields", async () => {
    const r = await buildCreateBody("alice.near", { chainKey: "base", loanAddress: "0x000000000000000000000000000000000000beef", fields: DEFAULT_FIELDS, salt: "00112233445566778899aabbccddeeff" });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.borrower).toBe("0x000000000000000000000000000000000000bEEF");
    expect(r.value.vaultId).toMatch(/^bkst-[0-9a-f]{20}\.near$/);
    const again = await buildCreateBody("alice.near", { chainKey: "base", loanAddress: "0x000000000000000000000000000000000000beef", fields: DEFAULT_FIELDS, salt: "00112233445566778899aabbccddeeff" });
    expect(again.ok && again.value.vaultId).toBe(r.value.vaultId);
    expect((await buildCreateBody("alice.near", { chainKey: "solana", loanAddress: ADDRESS, fields: DEFAULT_FIELDS, salt: "00112233445566778899aabbccddeeff" })).ok).toBe(false);
  });
});
