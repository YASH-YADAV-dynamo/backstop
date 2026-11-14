import { describe, expect, it } from "vitest";
import { KeyPair } from "near-api-js";
import { LOAN_CHAINS, NEAR, ONE_CLICK, type LoanChain } from "@backstop/config";
import {
  FACTORY_CONSTANTS,
  embeds,
  factoryAccountId,
  factoryBudget,
  factoryConfig,
  factoryDeployActions,
  factoryEnvLines,
  minDeposit,
} from "../src/lib/factory-plan.js";
import { SPARE_YOCTO, STATE_MARGIN_YOCTO } from "../src/lib/deploy-plan.js";

const input = {
  factoryId: "vaults.backstop.near",
  chains: LOAN_CHAINS,
  agent: "agent.backstop.near",
  feeAccount: "fees.backstop.near",
  feeBps: 10,
};
const NEAR_1 = 10n ** 24n;
const code = new Uint8Array([0, 97, 115, 109]);

describe("factory deploy plan", () => {
  it("factory_deploy_actions_have_no_add_key_unless_rehearsal", () => {
    const cfg = factoryConfig(input);
    const acts = factoryDeployActions(code, cfg, 7n);
    expect(acts.map((a) => a.enum)).toEqual(["createAccount", "transfer", "deployContract", "functionCall"]);
    expect(acts.some((a) => a.enum === "addKey")).toBe(false);
    expect(acts[1]!.transfer!.deposit).toBe(7n);
    const call = acts[3]!.functionCall!;
    expect(call.methodName).toBe("new");
    expect(JSON.parse(Buffer.from(call.args).toString())).toEqual({ config: cfg });
    expect(call.gas).toBe(50n * 10n ** 12n);
    expect(call.deposit).toBe(0n);

    const pk = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    const keyed = factoryDeployActions(code, cfg, 7n, pk);
    expect(keyed.map((a) => a.enum)).toEqual(["createAccount", "transfer", "addKey", "deployContract", "functionCall"]);
    expect(keyed[2]!.addKey!.publicKey.toString()).toBe(pk);
    expect(keyed[2]!.addKey!.accessKey.permission.enum).toBe("fullAccess");
  });

  it("factory_config_comes_from_loan_chains", () => {
    const cfg = factoryConfig(input);
    expect(cfg.chains).toEqual(
      LOAN_CHAINS.map((c) => ({ key: c.key, chain_id: c.chainId, aave_pool: c.aave.pool, usdc: c.aave.usdc, bridge_dest_asset: c.usdcAssetId })),
    );
    expect(cfg.chains.map((c) => c.key)).toEqual(["base", "arbitrum"]);
    expect(cfg).toMatchObject({
      usdc_near: NEAR.usdcToken,
      bridge_signer_pk: ONE_CLICK.managerPublicKey,
      mpc_contract: NEAR.mpcContract,
      derivation_path: NEAR.derivationPath,
      default_agent: "agent.backstop.near",
      fee_account: "fees.backstop.near",
      fee_bps: 10,
    });
    // Arbitrum gets native USDC (not USDC.e) and its own 1Click asset.
    const arb = cfg.chains[1]!;
    expect(arb.bridge_dest_asset.toLowerCase()).toContain(arb.usdc.toLowerCase());
  });

  it("rejects what the contract's new would reject, with its codes", () => {
    expect(() => factoryConfig({ ...input, feeBps: 51 })).toThrow(/ERR_FEE_ABOVE_CAP_BPS/);
    expect(() => factoryConfig({ ...input, feeAccount: input.factoryId })).toThrow(/ERR_FEE_ACCOUNT_IS_FACTORY/);
    expect(() => factoryConfig({ ...input, chains: [] })).toThrow(/ERR_NO_CHAINS/);
    const base = LOAN_CHAINS[0]!;
    expect(() => factoryConfig({ ...input, chains: [base, base] })).toThrow(/ERR_DUPLICATE_CHAIN/);
    const badKey = { ...base, key: "Base" } as unknown as LoanChain;
    expect(() => factoryConfig({ ...input, chains: [badKey] })).toThrow(/ERR_CHAIN_KEY_FORMAT/);
    const zeroPool = { ...base, aave: { ...base.aave, pool: "0x0000000000000000000000000000000000000000" } } as LoanChain;
    expect(() => factoryConfig({ ...input, chains: [zeroPool] })).toThrow(/aave_pool/);
    expect(() => factoryConfig({ ...input, agent: "Not An Account" })).toThrow(/AGENT_ACCOUNT_ID/);
  });

  it("names the factory <name>.<deployer> and keeps vault names within 64 chars", () => {
    expect(factoryAccountId("vaults", "backstop.near", LOAN_CHAINS)).toBe("vaults.backstop.near");
    expect(() => factoryAccountId("a.b", "backstop.near", LOAN_CHAINS)).toThrow(/one account label/);
    // "arbitrum-" + 20 digits + "." leaves 34 chars for the factory id.
    expect(factoryAccountId("v".repeat(20), "backstop.near", LOAN_CHAINS)).toHaveLength(34);
    expect(() => factoryAccountId("v".repeat(21), "backstop.near", LOAN_CHAINS)).toThrow(/at most 34/);
  });

  it("budget: factory code stake + margin + spare; min_deposit mirrors the contract", () => {
    const perByte = 10n ** 19n;
    const b = factoryBudget(468_817, 277_001, perByte);
    expect(b.codeStake).toBe(468_817n * perByte);
    expect(b.transfer).toBe(b.codeStake + STATE_MARGIN_YOCTO + SPARE_YOCTO);
    expect(b.deployerNeeds).toBe(b.transfer + b.gasReserve);
    expect(b.minDeposit).toBe(minDeposit(277_001, perByte));
    // 2.77001 + 0.05 + 0.1 + 0.00125 + 0.005 = 2.92626 NEAR (design K.1).
    expect(b.minDeposit).toBe(2_926_260n * 10n ** 18n);
    expect(FACTORY_CONSTANTS.ftStorageDeposit).toBe(1_250_000_000_000_000_000_000n);
    expect(b.minDeposit < 3n * NEAR_1).toBe(true);
  });

  it("checks the factory wasm embeds the policy wasm and prints the env lines", () => {
    expect(embeds(new Uint8Array([9, 0, 97, 115, 109, 9]), code)).toBe(true);
    expect(embeds(new Uint8Array([0, 97, 115]), code)).toBe(false);
    expect(factoryEnvLines("vaults.backstop.near", "ab".repeat(32))).toEqual([
      "FACTORY_CONTRACT_ID=vaults.backstop.near",
      "NEXT_PUBLIC_FACTORY_ID=vaults.backstop.near",
      `NEXT_PUBLIC_POLICY_CODE_HASH=${"ab".repeat(32)}`,
    ]);
  });
});
