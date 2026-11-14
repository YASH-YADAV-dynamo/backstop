import { LOAN_CHAINS } from "@backstop/config/registry";
import { describe, expect, it } from "vitest";
import { chainLabel, resolveChain } from "@/lib/chain";
import { wagmiConfig } from "@/lib/wagmi";

describe("the web app resolves the loan chain from the policy's chain id", () => {
  it("resolveChain returns null for an unsupported chain id", () => {
    expect(resolveChain(1)).toBeNull();
    expect(resolveChain(0)).toBeNull();
  });
  it("resolveChain finds every registry chain by its id", () => {
    for (const c of LOAN_CHAINS) expect(resolveChain(c.chainId)).toBe(c);
  });
  it("every LOAN_CHAINS id is in the wagmi config", () => {
    const ids = wagmiConfig.chains.map((c) => c.id as number);
    for (const c of LOAN_CHAINS) expect(ids).toContain(c.chainId);
  });
  it("the network line of a review names the chain and its id", () => {
    expect(chainLabel(LOAN_CHAINS[0]!)).toBe(`${LOAN_CHAINS[0]!.name} (chain id ${LOAN_CHAINS[0]!.chainId})`);
  });
});
