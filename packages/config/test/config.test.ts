import { describe, expect, it } from "vitest";
import { REMOVED_SECRET_VARS, isNearAccountId, loadEnv, loadWebEnv, rpcList } from "../src/env.js";
import * as registry from "../src/registry.js";
import { NEAR, ONE_CLICK, POLICY } from "../src/registry.js";

describe("registry", () => {
  it("near_usdc_token_matches_the_1click_asset_id", () => {
    expect(`nep141:${NEAR.usdcToken}`).toBe(ONE_CLICK.expectedUsdcNearAssetId);
  });

  it("has_no_single_default_rpc_only_fallback_lists", () => {
    expect(Object.keys(registry.NEAR)).not.toContain("defaultRpc");
    expect(Object.keys(registry.BASE)).not.toContain("defaultRpc");
    expect(NEAR.rpcUrls.length).toBeGreaterThanOrEqual(3);
    expect(registry.BASE.rpcUrls.length).toBeGreaterThanOrEqual(3);
    for (const u of [...NEAR.rpcUrls, ...registry.BASE.rpcUrls]) expect(u.startsWith("https://")).toBe(true);
  });

  it("arbitrum_uses_native_usdc_that_one_click_delivers_not_bridged_usdc_e", () => {
    const arb = registry.loanChainById(42161);
    expect(arb.aave.usdc.toLowerCase()).toBe("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
    expect(arb.usdcAssetId).toBe(`nep141:arb-${arb.aave.usdc.toLowerCase()}.omft.near`);
    const base = registry.loanChainById(8453);
    expect(base.usdcAssetId).toBe(`nep141:base-${base.aave.usdc.toLowerCase()}.omft.near`);
    expect(arb.aave.pool).not.toBe(base.aave.pool);
  });

  it("an_unsupported_chain_id_is_refused_with_the_supported_list", () => {
    expect(() => registry.loanChainById(1)).toThrow(/Base \(8453\), Arbitrum One \(42161\)/);
    expect(() => registry.loanChainByKey("solana")).toThrow(/base, arbitrum/);
  });

  it("agent_key_methods_are_exactly_the_three_agent_methods", () => {
    expect([...POLICY.agentMethods]).toEqual(["rescue", "fund_bridge", "approve_pool"]);
  });
});

describe("loadEnv", () => {
  it("removed_owner_and_policy_keys_fail_the_load", () => {
    for (const name of Object.keys(REMOVED_SECRET_VARS)) {
      expect(() => loadEnv({ [name]: "ed25519:abc" })).toThrow(/no longer used; delete it from \.env/);
    }
  });

  it("empty_removed_variables_are_ignored", () => {
    const empty = Object.fromEntries(Object.keys(REMOVED_SECRET_VARS).map((k) => [k, ""]));
    expect(() => loadEnv(empty)).not.toThrow();
  });

  it("parses_a_minimal_env_with_only_the_policy_id", () => {
    const env = loadEnv({ POLICY_CONTRACT_ID: "policy.alice.near" });
    expect(env.POLICY_CONTRACT_ID).toBe("policy.alice.near");
    expect(env.AGENT_PRIVATE_KEY).toBeUndefined();
  });

  it("rejects_an_invalid_account_id_and_says_where_to_look", () => {
    expect(() => loadEnv({ POLICY_CONTRACT_ID: "Bad..Id" })).toThrow(/POLICY_CONTRACT_ID.*\n.*\.env\.example/s);
  });

  it("rejects_non_https_rpc_urls", () => {
    expect(() => loadEnv({ NEAR_RPC_URL: "http://rpc.example" })).toThrow(/NEAR_RPC_URL/);
    expect(loadEnv({ NEAR_RPC_URL: "https://a.example, https://b.example" }).NEAR_RPC_URL).toContain("b.example");
  });
});

describe("bot service env", () => {
  it("policy_contract_ids_is_a_deduplicated_list_of_valid_account_ids", () => {
    const env = loadEnv({ POLICY_CONTRACT_IDS: "a.backstop.near, b.backstop.near,a.backstop.near" });
    expect(env.POLICY_CONTRACT_IDS).toEqual(["a.backstop.near", "b.backstop.near"]);
    expect(() => loadEnv({ POLICY_CONTRACT_IDS: "ok.near,Bad..Id" })).toThrow(/POLICY_CONTRACT_IDS/);
  });

  it("alert_webhook_must_be_https", () => {
    expect(() => loadEnv({ ALERT_WEBHOOK_URL: "http://hooks.example" })).toThrow(/ALERT_WEBHOOK_URL/);
    expect(loadEnv({ ALERT_WEBHOOK_URL: "https://hooks.example/x" }).ALERT_WEBHOOK_URL).toBe("https://hooks.example/x");
  });

  it("web_env_can_read_the_vault_status_file_location", () => {
    expect(loadWebEnv({ VAULT_STATUS_FILE: "/tmp/vs.json" }).VAULT_STATUS_FILE).toBe("/tmp/vs.json");
  });
});

describe("loadWebEnv", () => {
  it("web_env_never_contains_a_private_key", () => {
    const env = loadWebEnv({
      POLICY_CONTRACT_ID: "policy.alice.near",
      AGENT_PRIVATE_KEY: "ed25519:secret",
      DEPLOYER_PRIVATE_KEY: "ed25519:secret",
    });
    expect(env.POLICY_CONTRACT_ID).toBe("policy.alice.near");
    expect(JSON.stringify(env)).not.toContain("secret");
    expect(Object.keys(env).some((k) => k.endsWith("_PRIVATE_KEY"))).toBe(false);
  });
});

describe("rpcList", () => {
  it("puts_overrides_first_then_defaults_without_duplicates", () => {
    expect(rpcList("https://x.example,https://a.example", ["https://a.example", "https://b.example"])).toEqual([
      "https://x.example",
      "https://a.example",
      "https://b.example",
    ]);
    expect(rpcList(undefined, NEAR.rpcUrls)).toEqual([...NEAR.rpcUrls]);
  });

  it("rejects_non_https_overrides", () => {
    expect(() => rpcList("ftp://x", [])).toThrow(/not https/);
  });
});

describe("isNearAccountId", () => {
  it("accepts_named_sub_and_implicit_accounts_and_rejects_bad_ones", () => {
    expect(isNearAccountId("alice.near")).toBe(true);
    expect(isNearAccountId("p-1.policy.near")).toBe(true);
    expect(isNearAccountId("a".repeat(64))).toBe(true);
    expect(isNearAccountId("a")).toBe(false);
    expect(isNearAccountId("Alice.near")).toBe(false);
    expect(isNearAccountId("a..near")).toBe(false);
    expect(isNearAccountId("a".repeat(65))).toBe(false);
  });
});
