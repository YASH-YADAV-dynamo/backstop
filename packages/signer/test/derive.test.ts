import { describe, expect, it } from "vitest";
import { loanChainById } from "@backstop/config";
import { deriveEvmAddress } from "../src/index.js";

describe("deriveEvmAddress", () => {
  // Vector checked against mainnet v1.signer `derived_public_key` on 2026-11-12 (CLAUDE.md).
  it("derives the known address for example.near / ethereum-1 locally", async () => {
    const { address, publicKey } = await deriveEvmAddress(loanChainById(8453), "example.near", "ethereum-1");
    expect(address).toBe("0xEF4Ea05e5c11057DeCC8E1bd6F5369f2acD91fA5");
    expect(publicKey).toMatch(/^0x04[0-9a-f]{128}$/);
  });

  it("derives the same address on Arbitrum: the address does not depend on the chain", async () => {
    const base = await deriveEvmAddress(loanChainById(8453), "example.near", "ethereum-1");
    const arb = await deriveEvmAddress(loanChainById(42161), "example.near", "ethereum-1");
    expect(arb.address).toBe(base.address);
  });
});
