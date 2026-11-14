import { readFileSync } from "node:fs";
import { loanChainByKey, LOAN_CHAINS } from "@backstop/config/registry";
import { describe, expect, it } from "vitest";
import { classifyDebt, debtBlockReason } from "@/lib/debt";
import { buildCreateLimits, createBlockReason, DEFAULT_FIELDS, HIDDEN_LIMITS, returnedOnClose, type CreateInputs } from "@/lib/create-vault";
import { factoryMatchesSite, type FactoryInfo } from "@/lib/factory-client";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const MIN = 2_926_260_000_000_000_000_000_000n;
const ready: CreateInputs = {
  factoryReady: true,
  minDeposit: MIN,
  nearBalance: 10n * 10n ** 24n,
  loanAddress: ADDRESS,
  debtKind: "usdc",
  chainName: "Base",
  fields: DEFAULT_FIELDS,
  vaultCount: 0,
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
    expect(Number(limits.value.cooldown_secs)).toBe(num("cooldown_secs"));
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
  it("blocks creation for no debt and for non-USDC debt with calm copy", () => {
    expect(createBlockReason({ ...ready, debtKind: "none" })).toBe("We found no Aave loan at this address on Base.");
    expect(createBlockReason({ ...ready, debtKind: "other" })).toBe("This loan's debt isn't USDC. Backstop can only repay USDC debt for now.");
    expect(debtBlockReason("usdc", "Base")).toBeNull();
  });
});

describe("createBlockReason", () => {
  it("allows a funded owner with a USDC loan", () => {
    expect(createBlockReason(ready)).toBeNull();
  });
  it("waits for the factory, the debt read and a valid address", () => {
    expect(createBlockReason({ ...ready, factoryReady: false })).toMatch(/Checking/);
    expect(createBlockReason({ ...ready, debtKind: null })).toMatch(/Looking for your loan on Base/);
    expect(createBlockReason({ ...ready, loanAddress: "" })).toMatch(/Enter the address/);
    expect(createBlockReason({ ...ready, loanAddress: "0x12" })).toMatch(/0x followed by 40/);
  });
  it("not_enough_near_names_the_deposit_and_that_it_comes_back", () => {
    const r = createBlockReason({ ...ready, nearBalance: 1n * 10n ** 24n });
    expect(r).toBe("Opening a vault holds about 2.93 NEAR; you have 1 NEAR. You get it back when you close the vault.");
  });
  it("stops at eight vaults", () => {
    expect(createBlockReason({ ...ready, vaultCount: 8 })).toBe("You've reached the limit of 8 vaults. Close one to open another.");
  });
  it("returns the deposit minus what the factory keeps", () => {
    expect(returnedOnClose(MIN)).toBe(MIN - 6_250_000_000_000_000_000_000n);
  });
});

describe("factoryMatchesSite", () => {
  const base = loanChainByKey("base");
  const config = (over: Partial<FactoryInfo["config"]["chains"][number]> = {}): FactoryInfo["config"] => ({
    chains: LOAN_CHAINS.map((c) => ({ key: c.key, chain_id: c.chainId, aave_pool: c.aave.pool, usdc: c.aave.usdc, bridge_dest_asset: c.usdcAssetId, ...(c.key === "base" ? over : {}) })),
    usdc_near: "u",
    bridge_signer_pk: "k",
    mpc_contract: "v1.signer",
    derivation_path: "p",
    default_agent: "bot.near",
    fee_account: "fee.near",
    fee_bps: 10,
  });
  it("accepts a factory that matches the registry, Base first", () => {
    const v = factoryMatchesSite({ config: config(), keyCount: 0 });
    expect(v.ok && v.chains[0]!.key).toBe("base");
  });
  it("refuses a factory with access keys", () => {
    expect(factoryMatchesSite({ config: config(), keyCount: 1 }).ok).toBe(false);
  });
  it("refuses a factory whose pool, usdc or bridge asset differs (case-insensitive for addresses)", () => {
    expect(factoryMatchesSite({ config: config({ aave_pool: base.aave.pool.toLowerCase() }), keyCount: 0 }).ok).toBe(true);
    expect(factoryMatchesSite({ config: config({ aave_pool: "0x0000000000000000000000000000000000000001" }), keyCount: 0 }).ok).toBe(false);
    expect(factoryMatchesSite({ config: config({ usdc: "0x0000000000000000000000000000000000000001" }), keyCount: 0 }).ok).toBe(false);
    expect(factoryMatchesSite({ config: config({ bridge_dest_asset: "nep141:x" }), keyCount: 0 }).ok).toBe(false);
    expect(factoryMatchesSite({ config: config({ chain_id: 1 }), keyCount: 0 }).ok).toBe(false);
  });
  it("refuses a fee above the cap", () => {
    expect(factoryMatchesSite({ config: { ...config(), fee_bps: 51 }, keyCount: 0 }).ok).toBe(false);
  });
});
