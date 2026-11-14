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
  it("an unsupported chain id fails", () => {
    const check = constants(snapshotFor(baseChain, { chain_id: 1 }));
    expect(check.state).toBe("fail");
    expect(check.detail).toContain(SUPPORTED_CHAIN_NAMES);
  });
});
