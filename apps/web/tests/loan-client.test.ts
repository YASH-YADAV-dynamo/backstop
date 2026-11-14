import { createPublicClient, custom, type PublicClient } from "viem";
import { arbitrum, base } from "viem/chains";
import { describe, expect, it } from "vitest";
import { readLoan } from "@/lib/loan-client";
import { arbitrumChain, baseChain, BORROWER } from "./fixtures/policy";

/** A client whose RPC answers `eth_chainId` with `chainIdHex` and counts how often it was asked. */
function stubClient(chainIdHex: string) {
  const calls: string[] = [];
  const client = createPublicClient({
    chain: base,
    transport: custom({
      request: async ({ method }: { method: string }) => {
        calls.push(method);
        if (method === "eth_chainId") return chainIdHex;
        throw new Error(`unexpected ${method}: the chain id check must stop the read first`);
      },
    }),
  }) as PublicClient;
  return { client, calls };
}

describe("the browser refuses an RPC that serves another chain", () => {
  it("readLoan refuses an RPC that reports another chain id", async () => {
    const { client, calls } = stubClient("0xa4b1"); // 42161 = Arbitrum, asked for Base
    await expect(readLoan(baseChain, null, BORROWER, client)).rejects.toThrow(/answered chain id 42161, expected Base \(8453\)/);
    expect(calls).toEqual(["eth_chainId"]);
  });
  it("readLoan names the chain it expected when the RPC is Base but the policy is Arbitrum", async () => {
    const { client } = stubClient("0x2105"); // 8453
    await expect(readLoan(arbitrumChain, null, BORROWER, client)).rejects.toThrow(/expected Arbitrum One \(42161\)/);
  });
  it("a failed chain id check is retried on the next read instead of cached", async () => {
    let id = "0xa4b1";
    const client = createPublicClient({
      chain: arbitrum,
      transport: custom({ request: async ({ method }: { method: string }) => (method === "eth_chainId" ? id : "0x0") }),
    }) as PublicClient;
    await expect(readLoan(baseChain, null, BORROWER, client)).rejects.toThrow(/chain id 42161/);
    id = "0x2105";
    // The check now passes; the next failure is the (unstubbed) Aave call, not the chain id.
    await expect(readLoan(baseChain, null, BORROWER, client)).rejects.not.toThrow(/answered chain id/);
  });
});
