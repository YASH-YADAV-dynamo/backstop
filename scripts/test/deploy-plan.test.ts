import { describe, expect, it } from "vitest";
import { AAVE_ARBITRUM, AAVE_BASE, ARBITRUM, BASE, NEAR, ONE_CLICK, loanChainByKey } from "@backstop/config";
import { DEFAULT_LIMITS } from "../src/lib/limits.js";
import { KeyPair } from "near-api-js";
import {
  deployActions,
  deployBudget,
  finalizeActions,
  formatNear,
  initArgs,
  policyAccountId,
  redeployActions,
  SPARE_YOCTO,
  STATE_MARGIN_YOCTO,
} from "../src/lib/deploy-plan.js";

const base = loanChainByKey("base");
const arbitrum = loanChainByKey("arbitrum");

const input = {
  chain: base,
  name: "alice",
  deployer: "backstop.near",
  owner: "alice.near",
  agent: "agent.backstop.near",
  borrower: "0x000000000000000000000000000000000000beef",
  limits: DEFAULT_LIMITS,
  feeAccount: "fees.backstop.near",
  feeBps: 10,
};

describe("keyless deploy plan", () => {
  it("creates exactly CreateAccount, Transfer, DeployContract, new, activate: never AddKey", () => {
    const acts = deployActions(new Uint8Array([0, 97, 115, 109]), initArgs(input), 5n);
    expect(acts.map((a) => a.enum)).toEqual(["createAccount", "transfer", "deployContract", "functionCall", "functionCall"]);
    expect(acts.some((a) => a.enum === "addKey")).toBe(false);
    expect(acts.map((a) => a.functionCall?.methodName).filter(Boolean)).toEqual(["new", "activate"]);
    expect(acts[1]!.transfer!.deposit).toBe(5n);
  });

  it("rehearsal adds exactly one full-access key, the given one, and nothing else changes (F2)", () => {
    const pk = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    const acts = deployActions(new Uint8Array([0, 97, 115, 109]), initArgs(input), 5n, pk);
    expect(acts.map((a) => a.enum)).toEqual(["createAccount", "transfer", "addKey", "deployContract", "functionCall", "functionCall"]);
    const add = acts[2]!.addKey!;
    expect(add.publicKey.toString()).toBe(pk);
    expect(add.accessKey.permission.enum).toBe("fullAccess");
  });

  it("finalize deletes the rehearsal key and redeploy only replaces code", () => {
    const pk = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    const fin = finalizeActions(pk);
    expect(fin.map((a) => a.enum)).toEqual(["deleteKey"]);
    expect(fin[0]!.deleteKey!.publicKey.toString()).toBe(pk);
    expect(redeployActions(new Uint8Array([1])).map((a) => a.enum)).toEqual(["deployContract"]);
  });

  it("names the policy <name>.<deployer> and rejects dotted or overlong names", () => {
    expect(policyAccountId("alice", "backstop.near", base)).toBe("alice.backstop.near");
    expect(() => policyAccountId("a.b", "backstop.near", base)).toThrow(/one account label/);
    expect(() => policyAccountId("x".repeat(60), "backstop.near", base)).toThrow(/max 64/);
  });

  it("two chains for one user never collide: Base keeps its old name, Arbitrum gets -arb", () => {
    expect(policyAccountId("alice", "backstop.near", arbitrum)).toBe("alice-arb.backstop.near");
    expect(policyAccountId("alice", "backstop.near", arbitrum)).not.toBe(policyAccountId("alice", "backstop.near", base));
  });

  it("an Arbitrum policy is created with the Arbitrum pool, native USDCn (not USDC.e) and the arb 1Click asset", () => {
    const args = initArgs({ ...input, chain: arbitrum });
    expect(args).toMatchObject({
      chain_id: ARBITRUM.chainId,
      aave_pool: AAVE_ARBITRUM.pool,
      usdc_base: AAVE_ARBITRUM.usdc,
      bridge_dest_asset: ONE_CLICK.expectedUsdcArbitrumAssetId,
    });
    expect(args.usdc_base).toBe("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
    expect(args.usdc_base).not.toBe(AAVE_BASE.usdc);
    expect(String(args.bridge_dest_asset).toLowerCase()).toContain(String(args.usdc_base).toLowerCase());
  });

  it("takes every chain constant from the registry and checksums the borrower", () => {
    expect(initArgs(input)).toEqual({
      owner: "alice.near",
      agent: "agent.backstop.near",
      on_behalf_of: "0x000000000000000000000000000000000000bEEF",
      chain_id: BASE.chainId,
      aave_pool: AAVE_BASE.pool,
      usdc_base: AAVE_BASE.usdc,
      usdc_near: NEAR.usdcToken,
      bridge_dest_asset: ONE_CLICK.expectedUsdcBaseAssetId,
      bridge_signer_pk: ONE_CLICK.managerPublicKey,
      mpc_contract: NEAR.mpcContract,
      derivation_path: NEAR.derivationPath,
      limits: DEFAULT_LIMITS,
      fee_account: "fees.backstop.near",
      fee_bps: 10,
    });
  });

  it("refuses a fee above the contract's 50 bps cap or a bad fee account", () => {
    expect(initArgs({ ...input, feeBps: 50 }).fee_bps).toBe(50);
    expect(() => initArgs({ ...input, feeBps: 51 })).toThrow(/FEE_BPS/);
    expect(() => initArgs({ ...input, feeBps: -1 })).toThrow(/FEE_BPS/);
    expect(() => initArgs({ ...input, feeAccount: "Not Valid" })).toThrow(/FEE_ACCOUNT_ID/);
  });

  it("rejects a bad owner, agent or borrower", () => {
    expect(() => initArgs({ ...input, owner: "Alice" })).toThrow(/--owner/);
    expect(() => initArgs({ ...input, agent: "" })).toThrow(/--agent/);
    expect(() => initArgs({ ...input, borrower: "alice.near" })).toThrow(/--borrower/);
  });

  it("budgets the 277 KB optimised wasm: ~2.77 NEAR code (refunded by close) + state + 0.1 spare, plus storage_deposit and gas", () => {
    const b = deployBudget(277_247, 10n ** 19n, 1_250_000_000_000_000_000_000n);
    expect(b.codeStake).toBe(2_772_470_000_000_000_000_000_000n);
    expect(b.transfer).toBe(b.codeStake + STATE_MARGIN_YOCTO + SPARE_YOCTO);
    expect(b.deployerNeeds).toBe(b.transfer + b.storageDeposit + b.gasReserve);
    expect(formatNear(b.transfer)).toBe("2.92247 NEAR");
    expect(formatNear(b.deployerNeeds)).toBe("2.94372 NEAR");
  });
});
