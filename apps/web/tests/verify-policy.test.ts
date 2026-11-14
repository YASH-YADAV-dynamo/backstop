import { SUPPORTED_CHAIN_NAMES } from "@backstop/config/registry";
import { describe, expect, it } from "vitest";
import { verifyPolicy } from "@/lib/policy-client";
import { arbitrumChain, baseChain, snapshotFor } from "./fixtures/policy";

/** Bridged USDC.e on Arbitrum, Aave's own "USDC" entry there. Backstop repays only the native-USDC market. */
const USDC_E_ARBITRUM = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8";

const constants = (snap: ReturnType<typeof snapshotFor>) => verifyPolicy(snap, null).find((c) => c.id === "constants")!;

describe("policy verification is per chain", () => {
  it("an Arbitrum policy with Arbitrum constants passes", () => {
    expect(constants(snapshotFor(arbitrumChain)).state).toBe("pass");
    expect(constants(snapshotFor(baseChain)).state).toBe("pass");
  });
  it("an Arbitrum policy that names USDC.e fails the constants check", () => {
    expect(USDC_E_ARBITRUM.toLowerCase()).not.toBe(arbitrumChain.aave.usdc.toLowerCase());
    const check = constants(snapshotFor(arbitrumChain, { usdc_base: USDC_E_ARBITRUM }));
    expect(check.state).toBe("fail");
    expect(check.detail).toContain("repay asset is Arbitrum One USDC");
  });
  it("a policy with Base pool but Arbitrum chain_id fails", () => {
    const check = constants(snapshotFor(arbitrumChain, { aave_pool: baseChain.aave.pool }));
    expect(check.state).toBe("fail");
    expect(check.detail).toContain("Aave pool is the official Arbitrum One pool");
  });
  it("owner_check_fails_when_the_connected_account_is_not_the_vault_owner", () => {
    const snap = snapshotFor(baseChain);
    expect(verifyPolicy(snap, null, { owner: "alice.near" }).find((c) => c.id === "owner")!.state).toBe("pass");
    const other = verifyPolicy(snap, null, { owner: "mallory.near" }).find((c) => c.id === "owner")!;
    expect(other.state).toBe("fail");
    expect(other.detail).toContain("alice.near");
    expect(verifyPolicy(snap, null).some((c) => c.id === "owner")).toBe(false);
  });
  it("agent_check_flags_a_vault_whose_bot_is_not_the_backstop_bot", () => {
    const snap = snapshotFor(baseChain);
    expect(verifyPolicy(snap, null, { agent: "agent.near" }).find((c) => c.id === "agent")!.state).toBe("pass");
    expect(verifyPolicy(snap, null, { agent: "bot.backstop.near" }).find((c) => c.id === "agent")!.state).toBe("unknown");
  });
  it("an unsupported chain id fails", () => {
    const check = constants(snapshotFor(baseChain, { chain_id: 1 }));
    expect(check.state).toBe("fail");
    expect(check.detail).toContain(SUPPORTED_CHAIN_NAMES);
  });
});
