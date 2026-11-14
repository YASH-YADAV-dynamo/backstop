import { LOAN_CHAINS } from "@backstop/config/registry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FactoryInfo } from "@/lib/factory-client";

const MIN = 2_926_260_000_000_000_000_000_000n;
const FACTORY = "vaults.backstop.near";
const OWNER = "alice.near";
const ADDRESS = "0x1111111111111111111111111111111111111111";

let info: FactoryInfo;
let debtKind: "usdc" | "none" | "other";
let ownerBalance: bigint;
let existing: string[];

const goodConfig = (): FactoryInfo["config"] => ({
  chains: LOAN_CHAINS.map((c) => ({ key: c.key, chain_id: c.chainId, aave_pool: c.aave.pool, usdc: c.aave.usdc, bridge_dest_asset: c.usdcAssetId })),
  usdc_near: "u",
  bridge_signer_pk: "k",
  mpc_contract: "v1.signer",
  derivation_path: "p",
  default_agent: "bot.backstop.near",
  fee_account: "fee.near",
  fee_bps: 10,
});

vi.mock("@/lib/public-env", () => ({ PUBLIC_ENV: { factoryId: "vaults.backstop.near" } }));
vi.mock("@/lib/factory-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/factory-client")>()),
  readFactory: vi.fn(async () => info),
  readOwnerPolicies: vi.fn(async () => existing),
  readRefund: vi.fn(async () => 0n),
}));
vi.mock("@/lib/loan-client", () => ({
  readDebt: vi.fn(async () => ({ kind: debtKind, healthFactor: null, debtBase: 1n, collateralBase: 1n })),
  readEthBalance: vi.fn(),
  readLoan: vi.fn(),
}));
vi.mock("@/lib/near-rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/near-rpc")>()),
  viewAccount: vi.fn(async () => ({ amount: ownerBalance, codeHash: "x", storageUsage: 1 })),
}));

const { prepareCreatePolicy } = await import("@/lib/review");
const input = { chainKey: "base", loanAddress: ADDRESS, fields: { triggerHf: "1.10", maxPerRescue: "5", dailyCap: "10" } };

beforeEach(() => {
  info = { factoryId: FACTORY, config: goodConfig(), minDeposit: MIN, codeHash: "ab".repeat(32), keyCount: 0 };
  debtKind = "usdc";
  ownerBalance = 10n * 10n ** 24n;
  existing = [];
});

describe("prepareCreatePolicy", () => {
  it("sends one create_policy call with the on-chain minimum deposit, 300 TGas and no owner, agent or name argument", async () => {
    const r = await prepareCreatePolicy(OWNER, input);
    if (!r.ok || r.network !== "near") throw new Error("expected a NEAR review");
    const tx = r.txs[0]!;
    expect(tx.receiverId).toBe(FACTORY);
    expect(tx.calls).toHaveLength(1);
    const call = tx.calls[0]!;
    expect(call.methodName).toBe("create_policy");
    expect(call.depositYocto).toBe(MIN.toString());
    expect(call.gasTgas).toBe(300);
    expect(Object.keys(call.args).sort()).toEqual(["chain", "limits", "on_behalf_of"]);
    expect(r.sentence).toBe("Create your Rescue vault on Base.");
    expect(r.rows.map(([l]) => l)).toEqual(expect.arrayContaining(["Loan chain", "Loan address on Base", "Rescue at health", "Most per rescue", "Most per day", "Rescue bot", "Service fee", "Vault owner", "Refundable deposit"]));
    expect(r.notes[0]).toBe("Refundable deposit: 2.926 NEAR. This keeps your vault on NEAR. You get it back when you close your vault.");
  });
  it("refuses_a_factory_with_access_keys", async () => {
    info.keyCount = 1;
    const r = await prepareCreatePolicy(OWNER, input);
    expect(r.ok).toBe(false);
  });
  it("refuses_a_factory_whose_chain_config_differs_from_the_site", async () => {
    info.config.chains[0]!.aave_pool = "0x0000000000000000000000000000000000000001";
    expect((await prepareCreatePolicy(OWNER, input)).ok).toBe(false);
  });
  it("loan_without_usdc_debt_cannot_be_protected", async () => {
    debtKind = "none";
    const none = await prepareCreatePolicy(OWNER, input);
    expect(none).toEqual({ ok: false, reason: "We found no Aave loan at this address on Base." });
    debtKind = "other";
    const other = await prepareCreatePolicy(OWNER, input);
    expect(other).toEqual({ ok: false, reason: "This loan's debt isn't USDC. Backstop can only repay USDC debt for now." });
  });
  it("refuses when the account cannot cover the deposit and says it is returned", async () => {
    ownerBalance = 2n * 10n ** 24n;
    const r = await prepareCreatePolicy(OWNER, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("You get it back when you close the vault.");
  });
  it("refuses the ninth vault", async () => {
    existing = Array.from({ length: 8 }, (_, i) => `base-${i}.${FACTORY}`);
    const r = await prepareCreatePolicy(OWNER, input);
    expect(r).toEqual({ ok: false, reason: "You've reached the limit of 8 vaults. Close one to open another." });
  });
});
